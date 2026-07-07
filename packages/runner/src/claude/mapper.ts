/**
 * Claude Agent SDK 消息 → protocol SessionEnvelope 映射。
 * 语义对齐 happy-cli 的 MessageAdapter，但目标是我们采纳的 sessionProtocol envelope。
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createEnvelope, type SessionEnvelope } from '@co/protocol';

interface ContentBlockLike {
  type: string;
  [key: string]: unknown;
}

function blocksOf(message: unknown): ContentBlockLike[] {
  const content = (message as { content?: unknown })?.content;
  return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

const OUTPUT_MAX = 4096; // ~4KB，mapper 侧截断

/** tool_result 的 content：string，或 content-block 数组（取 type==='text' 拼接） */
function textFromToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlockLike[])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

/** 单条 SDK 消息可能展开为多个 envelope（一条 assistant 消息含 text + 多个 tool_use） */
export function mapSdkMessage(m: SDKMessage): SessionEnvelope[] {
  const out: SessionEnvelope[] = [];

  switch (m.type) {
    case 'assistant': {
      const claudeUuid = typeof (m as { uuid?: unknown }).uuid === 'string' ? (m as { uuid: string }).uuid : undefined;
      for (const block of blocksOf((m as { message?: unknown }).message)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          out.push(createEnvelope('agent', { t: 'text', text: block.text }, { claudeUuid }));
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
          out.push(createEnvelope('agent', { t: 'text', text: block.thinking, thinking: true }, { claudeUuid }));
        } else if (block.type === 'tool_use') {
          out.push(
            createEnvelope('agent', {
              t: 'tool-call-start',
              call: String(block.id ?? ''),
              name: String(block.name ?? ''),
              title: String(block.name ?? ''),
              description: '',
              args: (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>,
            }),
          );
        }
      }
      break;
    }
    case 'user': {
      // SDK 回灌的 user 消息里的 tool_result = 工具执行结束
      for (const block of blocksOf((m as { message?: unknown }).message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          let output = textFromToolResult(block.content);
          if (output.length > OUTPUT_MAX) output = output.slice(0, OUTPUT_MAX) + '…[截断]';
          const isError = block.is_error === true;
          out.push(
            createEnvelope('agent', {
              t: 'tool-call-end',
              call: block.tool_use_id,
              ...(output ? { output } : {}),
              ...(isError ? { isError: true } : {}),
            }),
          );
        }
      }
      break;
    }
    case 'result': {
      const subtype = (m as { subtype?: string }).subtype;
      const isError = (m as { is_error?: boolean }).is_error === true;
      out.push(
        createEnvelope('agent', {
          t: 'turn-end',
          status: subtype === 'success' && !isError ? 'completed' : 'failed',
        }),
      );
      break;
    }
    case 'system': {
      const subtype = (m as { subtype?: string }).subtype;
      if (subtype === 'init') {
        out.push(createEnvelope('agent', { t: 'start' }));
      }
      break;
    }
    default:
      break;
  }

  return out;
}
