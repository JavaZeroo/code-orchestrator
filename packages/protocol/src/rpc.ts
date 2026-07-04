/**
 * runner ↔ server 传输协议：纯 WebSocket + JSON-RPC 2.0（设计决策 §12.5）。
 * 两个方向各有一张方法表，params/result 均为 Zod schema——接收方校验后分发。
 */

import * as z from 'zod';
import { sessionEnvelopeSchema } from './vendor/happy-wire/sessionProtocol';
import { MessageMetaSchema } from './vendor/happy-wire/messageMeta';
import { approvalDecisionSchema, approvalRequestSchema } from './approval';
import { machineInfoSchema } from './machine';
import { sessionAgentSchema, sessionStateSchema } from './session';

// ---------- JSON-RPC 2.0 封套 ----------

export const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

/** id 缺省即 notification */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

export const jsonRpcMessageSchema = z.union([jsonRpcRequestSchema, jsonRpcResponseSchema]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

// ---------- server → runner ----------

export const runnerMethods = {
  'session.spawn': {
    params: z.object({
      sessionId: z.string(),
      agent: sessionAgentSchema,
      cwd: z.string(),
      /** 首条用户消息；缺省则空会话等待 session.send */
      prompt: z.string().optional(),
      meta: MessageMetaSchema.optional(),
      /** 模型端点注入（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等），CLI×模型解耦的落点 */
      env: z.record(z.string(), z.string()).optional(),
      /** 工作流设计器会话：注入 emit_workflow 工具（in-process MCP） */
      designer: z.boolean().optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      nativeSessionId: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  'session.send': {
    params: z.object({
      sessionId: z.string(),
      text: z.string(),
      meta: MessageMetaSchema.optional(),
    }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  'session.kill': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'approval.decide': {
    params: z.object({
      approvalId: z.string(),
      sessionId: z.string(),
      decision: approvalDecisionSchema,
    }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** 机器级命令执行（worktree 准备、环境探测等） */
  'machine.exec': {
    params: z.object({
      cmd: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    result: z.object({
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
    }),
  },
} as const;

// ---------- runner → server ----------

export const serverMethods = {
  'machine.register': {
    params: z.object({ info: machineInfoSchema }),
    result: z.object({ ok: z.boolean(), serverTime: z.number() }),
  },
  'machine.heartbeat': {
    params: z.object({
      machineId: z.string(),
      sessions: z
        .array(z.object({ sessionId: z.string(), state: sessionStateSchema }))
        .default([]),
    }),
    result: z.object({ ok: z.boolean() }),
  },
  'session.event': {
    params: z.object({ sessionId: z.string(), envelope: sessionEnvelopeSchema }),
    result: z.object({ seq: z.number() }),
  },
  'session.state': {
    params: z.object({
      sessionId: z.string(),
      state: sessionStateSchema,
      /** CLI 原生会话 id（Claude 的 JSONL session id），init 后随状态上报 */
      nativeSessionId: z.string().optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },
  'approval.request': {
    params: z.object({ request: approvalRequestSchema }),
    result: z.object({ ok: z.boolean() }),
  },
  /** designer 会话的 emit_workflow 工具产出（server 校验后广播草图事件） */
  'workflow.draft': {
    params: z.object({ sessionId: z.string(), graph: z.unknown() }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
} as const;

// ---------- 类型助手 ----------

export type RunnerMethodName = keyof typeof runnerMethods;
export type ServerMethodName = keyof typeof serverMethods;

export type RunnerParams<M extends RunnerMethodName> = z.infer<(typeof runnerMethods)[M]['params']>;
export type RunnerResult<M extends RunnerMethodName> = z.infer<(typeof runnerMethods)[M]['result']>;
export type ServerParams<M extends ServerMethodName> = z.infer<(typeof serverMethods)[M]['params']>;
export type ServerResult<M extends ServerMethodName> = z.infer<(typeof serverMethods)[M]['result']>;
