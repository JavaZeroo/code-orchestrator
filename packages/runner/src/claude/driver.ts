/**
 * Claude 会话驱动：对着 @anthropic-ai/claude-agent-sdk 公开 API 实现，
 * 驱动循环 / 审批挂起 / 状态机语义取自 happy-cli 的 claudeRemote + PermissionHandler
 * （见 VENDOR_PLAN.md——代码未搬运，语义对齐）。
 *
 * 状态机：starting →(init) thinking →(result) idle →(send) thinking
 *         →(canUseTool) waiting_approval →(decide) thinking；kill → dead
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import * as z from 'zod';
import {
  createEnvelope,
  workflowDefSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type MessageMeta,
  type RunnerParams,
  type SessionEnvelope,
  type SessionState,
} from '@co/protocol';
import { Pushable } from '../utils/pushable';
import { mapSdkMessage } from './mapper';

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

export interface DriverEmit {
  event: (envelope: SessionEnvelope) => void;
  state: (state: SessionState, nativeSessionId?: string, usage?: SessionUsage) => void;
  approval: (request: ApprovalRequest) => void;
  /** designer 会话：草图上报，返回 server 校验结果（失败信息回给模型自动重试） */
  draft: (graph: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** taskIntake 会话：任务计划上报，返回 server 校验结果 */
  taskPlan: (plan: { defId: string; vars: Record<string, string>; summary: string }) => Promise<{ ok: boolean; error?: string }>;
}

const TASK_INTAKE_SYSTEM_PROMPT = `你是任务受理助手。用户描述要做什么，你负责从可用模板清单中选出合适的一个并填写变量。

规则：
- 仔细阅读下方「可用模板」清单，根据用户需求选择最匹配的模板
- 调用 emit_task_plan 工具输出 { defId, vars, summary }——defId 是所选模板的 id，vars 是变量值，summary 是对本次任务的简短描述
- 每次修改计划（换模板、改变量）都必须重新调用 emit_task_plan
- 如果清单里没有任何模板能匹配用户需求，调用 emit_workflow 现场编排新图
- 先理解需求，再选择或编排，不要过早调用工具`;

const DESIGNER_SYSTEM_PROMPT = `你是工作流设计助手。用户会用自然语言描述开发流程，你负责把它落成工作流图。

规则：
- 每当你给出或修改方案，必须调用 emit_workflow 工具输出完整工作流 JSON（用户界面会实时渲染成图）；纯文字描述不算数
- 当前引擎只支持两种节点：type="agent"（字段：id, title, role, cli?, model, prompt, cwd?, machine?{labels[]}, outputs?；cli 可用 "claude" 或 "codex"，缺省 "claude"）和 type="gate"（字段：id, title, approvers[]）
- prompt 里可用 {{vars.xxx}} 引用启动变量、{{outputs.节点id}} 引用上游 agent 节点的产出摘要
- edges 是 [from, to] 数组；图必须无环；节点 id 用短英文
- 工作目录通常留给运行时变量（写 {{vars.cwd}} 或不填 cwd 让引擎用 vars.cwd）
- 工具校验失败会返回具体错误，修正后重新调用
- 用户确认后由界面保存，你不负责保存；继续根据反馈迭代即可`;

const DENY_DEFAULT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected " +
  '(eg. if it was a file edit, the new_string was NOT written to the file). ' +
  'STOP what you are doing and wait for the user to tell you how to proceed.';

function mapPermissionMode(mode: MessageMeta['permissionMode']): Options['permissionMode'] {
  switch (mode) {
    case 'acceptEdits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
    case 'safe-yolo':
    case 'yolo':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

export class ClaudeSession {
  readonly sessionId: string;
  state: SessionState = 'starting';
  nativeSessionId: string | undefined;

  private readonly input = new Pushable<SDKUserMessage>();
  private readonly abort = new AbortController();
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private q: Query | null = null;
  private readonly usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0 };

  constructor(
    private readonly params: RunnerParams<'session.spawn'>,
    private readonly emit: DriverEmit,
  ) {
    this.sessionId = params.sessionId;
  }

  /** 拉起 SDK 循环（后台运行，错误经 service envelope 上报） */
  start(): void {
    void this.run().catch((err) => {
      this.emit.event(
        createEnvelope('agent', { t: 'service', text: `session crashed: ${err instanceof Error ? err.message : String(err)}` }),
      );
      this.setState('dead');
    });
  }

  send(text: string, meta?: MessageMeta): void {
    this.emit.event(createEnvelope('user', { t: 'text', text }));
    this.emit.event(createEnvelope('agent', { t: 'turn-start' }));
    this.input.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as SDKUserMessage);
    void meta; // 首版忽略逐条 meta 覆盖（模式切换 M2 做）
    this.setState('thinking');
  }

  async interrupt(): Promise<boolean> {
    if (!this.q || this.state === 'dead') {
      return false;
    }
    try {
      await this.q.interrupt();
      this.emit.event(createEnvelope('agent', { t: 'service', text: '回合已被用户打断' }));
      return true;
    } catch (err) {
      this.emit.event(
        createEnvelope('agent', { t: 'service', text: `打断失败: ${err instanceof Error ? err.message : String(err)}` }),
      );
      return false;
    }
  }

  kill(): void {
    this.input.end();
    this.abort.abort();
    for (const resolve of this.pendingApprovals.values()) {
      resolve({ behavior: 'deny', message: 'session killed' });
    }
    this.pendingApprovals.clear();
    this.emit.event(createEnvelope('agent', { t: 'stop' }));
    this.setState('dead');
  }

  decideApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) {
      return false;
    }
    this.pendingApprovals.delete(approvalId);
    resolve(decision);
    return true;
  }

  private setState(state: SessionState, nativeSessionId?: string, usage?: SessionUsage): void {
    if (this.state === 'dead') {
      return;
    }
    if (this.state !== state || nativeSessionId || usage) {
      this.state = state;
      this.emit.state(state, nativeSessionId, usage);
    }
  }

  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    // designer 自带工具免审批
    if (toolName.startsWith('mcp__designer__')) {
      return { behavior: 'allow', updatedInput: input };
    }
    const approvalId = createId();
    const request: ApprovalRequest = {
      id: approvalId,
      kind: 'tool',
      sessionId: this.sessionId,
      title: `${toolName}`,
      payload: { toolName, input },
      requestedAt: Date.now(),
    };
    this.setState('waiting_approval');
    this.emit.approval(request);

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
      options.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingApprovals.delete(approvalId)) {
            resolve({ behavior: 'deny', message: 'tool call aborted' });
          }
        },
        { once: true },
      );
    });

    this.setState('thinking');
    if (decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: { ...input, ...(decision.updatedInput ?? {}) } };
    }
    return { behavior: 'deny', message: decision.message ?? DENY_DEFAULT_MESSAGE };
  };

  private buildDesignerMcp() {
    return createSdkMcpServer({
      name: 'designer',
      version: '0.1.0',
      tools: [
        tool(
          'emit_workflow',
          '输出/更新工作流草图，用户界面会实时渲染。graph 传 JSON 对象（不要序列化成字符串），结构：{name, description?, vars?, nodes: [...], edges: [[from,to],...]}。',
          { graph: z.unknown() },
          async (args) => {
            // 模型可能把对象序列化成字符串传入，容忍处理
            let graph = args.graph;
            if (typeof graph === 'string') {
              try {
                graph = JSON.parse(graph);
              } catch {
                return {
                  content: [{ type: 'text', text: 'graph 是无法解析的字符串。请把 graph 作为 JSON 对象传入（不要字符串化）。' }],
                  isError: true,
                };
              }
            }
            const parsed = workflowDefSchema.safeParse(graph);
            if (!parsed.success) {
              const issues = parsed.error.issues
                .slice(0, 5)
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ');
              return { content: [{ type: 'text', text: `schema 校验失败，请修正后重试: ${issues}` }], isError: true };
            }
            const result = await this.emit.draft(parsed.data);
            if (!result.ok) {
              return { content: [{ type: 'text', text: `server 拒绝: ${result.error ?? '未知错误'}` }], isError: true };
            }
            return { content: [{ type: 'text', text: '草图已推送到界面。等待用户反馈，或根据用户下一条消息继续修改。' }] };
          },
        ),
      ],
    });
  }

  private buildTaskIntakeMcp() {
    return createSdkMcpServer({
      name: 'task_intake',
      version: '0.1.0',
      tools: [
        tool(
          'emit_task_plan',
          '当你判断出当前任务适合哪个模板、填好变量后，调用此工具输出计划。每次修改计划必须重新调用。',
          { defId: z.string(), vars: z.record(z.string(), z.string()), summary: z.string() },
          async (args) => {
            const result = await this.emit.taskPlan({ defId: args.defId, vars: args.vars, summary: args.summary });
            if (!result.ok) {
              return { content: [{ type: 'text', text: `server 拒绝: ${result.error ?? '未知错误'}` }], isError: true };
            }
            return { content: [{ type: 'text', text: '计划已推送到界面。等待用户确认启动，或根据反馈修改计划后重新调用 emit_task_plan。' }] };
          },
        ),
      ],
    });
  }

  private async run(): Promise<void> {
    const p = this.params;
    const meta = p.meta ?? {};

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    Object.assign(env, p.env ?? {});
    // 不落入 --resume picker 的 sdk-* 过滤集，保持会话对 `claude --resume` 可见（happy#1202 的经验）
    env.CLAUDE_CODE_ENTRYPOINT = env.CLAUDE_CODE_ENTRYPOINT ?? 'co-runner';

    const appendParts = [meta.appendSystemPrompt, p.designer ? DESIGNER_SYSTEM_PROMPT : undefined, p.taskIntake ? TASK_INTAKE_SYSTEM_PROMPT : undefined].filter(
      (s): s is string => Boolean(s),
    );
    const options: Options = {
      cwd: p.cwd,
      model: meta.model ?? undefined,
      fallbackModel: meta.fallbackModel ?? undefined,
      permissionMode: mapPermissionMode(meta.permissionMode),
      effort: meta.effort ?? undefined,
      allowedTools: meta.allowedTools ?? undefined,
      disallowedTools: meta.disallowedTools ?? undefined,
      systemPrompt: meta.customSystemPrompt
        ? meta.customSystemPrompt
        : appendParts.length > 0
          ? { type: 'preset', preset: 'claude_code', append: appendParts.join('\n\n') }
          : undefined,
      env,
      abortController: this.abort,
      canUseTool: this.canUseTool,
      // 把 claude CLI 的 stderr 透出来（容器内诊断用；平时也有助定位 CLI 层错误）
      stderr: (data: string) => process.stderr.write(`[claude-cli] ${data}`),
    };

    if (p.designer) {
      options.mcpServers = { designer: this.buildDesignerMcp() };
      options.allowedTools = [...(options.allowedTools ?? []), 'mcp__designer__emit_workflow'];
    }
    if (p.taskIntake) {
      options.mcpServers = { ...(options.mcpServers ?? {}), task_intake: this.buildTaskIntakeMcp() };
      options.allowedTools = [
        ...(options.allowedTools ?? []),
        'mcp__task_intake__emit_task_plan',
      ];
      // taskIntake 也引入 emit_workflow 工具（通过复用 designer MCP）
      if (!p.designer) {
        options.mcpServers = { ...options.mcpServers, designer: this.buildDesignerMcp() };
        options.allowedTools = [...(options.allowedTools ?? []), 'mcp__designer__emit_workflow'];
      }
    }

    if (p.prompt) {
      this.send(p.prompt);
    }

    this.q = query({ prompt: this.input, options });

    for await (const message of this.q) {
      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
        const nativeId = (message as { session_id?: string }).session_id;
        if (nativeId) {
          this.nativeSessionId = nativeId;
        }
        this.setState('thinking', nativeId);
      }
      for (const envelope of mapSdkMessage(message)) {
        this.emit.event(envelope);
      }
      if (message.type === 'result') {
        const m = message as {
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
          total_cost_usd?: number;
        };
        this.usage.turns += 1;
        this.usage.inputTokens += m.usage?.input_tokens ?? 0;
        this.usage.outputTokens += m.usage?.output_tokens ?? 0;
        this.usage.cacheReadTokens += m.usage?.cache_read_input_tokens ?? 0;
        this.usage.costUsd += m.total_cost_usd ?? 0;
        this.setState('idle', undefined, { ...this.usage });
      }
    }
    this.setState('dead');
  }
}
