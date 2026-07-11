/**
 * Codex 会话驱动：通过 `codex app-server --stdio` 使用 Codex 的富客户端 JSON-RPC 接口。
 * app-server 负责 thread/turn 历史、流式 item 事件与审批回调；本驱动只做协议桥接：
 * Codex JSON-RPC ↔ co 的 SessionEnvelope / ApprovalRequest。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { createId } from '@paralleldrive/cuid2';
import {
  createEnvelope,
  type ApprovalDecision,
  type ApprovalRequest,
  type MessageMeta,
  type RunnerParams,
  type SessionEnvelope,
  type SessionState,
} from '@co/protocol';
import type { DriverEmit, SessionUsage } from '../claude/driver';

type RpcId = string | number;

interface RpcError {
  code?: number;
  message: string;
  data?: unknown;
}

interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: RpcError;
}

interface RpcRequest {
  id?: RpcId;
  method: string;
  params?: unknown;
}

interface PendingApproval {
  requestId: RpcId;
  method: string;
}

const OUTPUT_MAX = 4096;
const CODEX_CLIENT_INFO = { name: 'code_orchestrator', title: 'code-orchestrator', version: '0.1.0' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function truncate(value: string): string {
  return value.length > OUTPUT_MAX ? `${value.slice(0, OUTPUT_MAX)}…[截断]` : value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapApprovalPolicy(mode: MessageMeta['permissionMode']): 'untrusted' | 'on-request' | 'never' {
  switch (mode) {
    case 'bypassPermissions':
    case 'safe-yolo':
    case 'yolo':
      return 'never';
    case 'acceptEdits':
    case 'plan':
    case 'read-only':
      return 'on-request';
    default:
      return 'untrusted';
  }
}

function mapSandbox(mode: MessageMeta['permissionMode']): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (mode) {
    case 'bypassPermissions':
    case 'safe-yolo':
    case 'yolo':
      return 'danger-full-access';
    case 'plan':
    case 'read-only':
      return 'read-only';
    default:
      return 'workspace-write';
  }
}

function textInput(text: string): Array<{ type: 'text'; text: string; text_elements: [] }> {
  return [{ type: 'text', text, text_elements: [] }];
}

function turnStatus(status: unknown): 'completed' | 'failed' | 'cancelled' {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'cancelled';
  return 'failed';
}

function itemId(item: Record<string, unknown>): string {
  return str(item.id) ?? createId();
}

function itemType(item: Record<string, unknown>): string {
  return str(item.type) ?? 'unknown';
}

function commandTitle(item: Record<string, unknown>): string {
  return str(item.command) ?? 'command';
}

function codexRequestTitle(method: string, params: Record<string, unknown>): string {
  if (method === 'item/tool/requestUserInput') {
    const firstQuestion = Array.isArray(params.questions) ? obj(params.questions[0]) : {};
    return str(firstQuestion.header) ?? str(firstQuestion.question) ?? 'Codex needs input';
  }
  if (method === 'item/commandExecution/requestApproval') {
    return str(params.command) ?? 'Codex command approval';
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return 'Codex file change approval';
  }
  if (method === 'execCommandApproval') {
    const command = Array.isArray(params.command) ? params.command.map(String).join(' ') : undefined;
    return command || 'Codex command approval';
  }
  return `Codex approval: ${method}`;
}

export class CodexSession {
  readonly sessionId: string;
  state: SessionState = 'starting';
  nativeSessionId: string | undefined;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRpcId = 1;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private started = false;
  private dead = false;
  private ready: Promise<void> | null = null;
  private readonly pendingRpc = new Map<RpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly agentText = new Map<string, string>();
  private readonly toolOutput = new Map<string, string>();
  private readonly usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0 };

  constructor(
    private readonly params: RunnerParams<'session.spawn'>,
    private readonly emit: DriverEmit,
    private readonly resumeNativeSessionId?: string,
  ) {
    this.sessionId = params.sessionId;
    this.nativeSessionId = resumeNativeSessionId;
  }

  start(): void {
    this.ready = this.run().catch((err) => {
      this.emit.event(
        createEnvelope('agent', { t: 'service', text: `codex session crashed: ${err instanceof Error ? err.message : String(err)}` }),
      );
      this.setState('dead');
    });
  }

  send(text: string, meta?: MessageMeta): void {
    this.emit.event(createEnvelope('user', { t: 'text', text }));
    this.emit.event(createEnvelope('agent', { t: 'turn-start' }));
    this.setState('thinking');
    void (this.ready ?? Promise.resolve()).then(() => this.startOrSteerTurn(text, meta)).catch((err) => {
      this.emit.event(
        createEnvelope('agent', { t: 'service', text: `codex send failed: ${err instanceof Error ? err.message : String(err)}` }),
      );
      this.emit.event(createEnvelope('agent', { t: 'turn-end', status: 'failed' }));
      this.setState('idle');
    });
  }

  async interrupt(): Promise<boolean> {
    if (!this.threadId || !this.activeTurnId || this.state === 'dead') {
      return false;
    }
    try {
      await this.sendRequest('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
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
    if (this.dead) return;
    for (const approvalId of [...this.pendingApprovals.keys()]) {
      this.respondApproval(approvalId, { behavior: 'deny', message: 'session killed' });
    }
    this.pendingApprovals.clear();
    this.child?.kill('SIGTERM');
    setTimeout(() => this.child?.kill('SIGKILL'), 1500);
    this.emit.event(createEnvelope('agent', { t: 'stop' }));
    this.setState('dead');
  }

  decideApproval(approvalId: string, decision: ApprovalDecision): boolean {
    return this.respondApproval(approvalId, decision);
  }

  private async run(): Promise<void> {
    const p = this.params;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    Object.assign(env, p.env ?? {});

    const codexBin = p.env?.CODEX_BIN ?? process.env.CODEX_BIN ?? 'codex';
    const child = spawn(codexBin, ['app-server', '--stdio'], {
      cwd: p.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr.on('data', (data: Buffer) => {
      const s = data.toString();
      if (s.trim()) process.stderr.write(`[codex-cli] ${s}`);
    });
    child.on('exit', (code) => {
      if (this.state !== 'dead') {
        this.emit.event(createEnvelope('agent', { t: 'service', text: `Codex app-server exited (code=${code})` }));
        this.setState('dead');
      }
    });
    child.on('error', (err) => {
      this.emit.event(createEnvelope('agent', { t: 'service', text: `Codex app-server 启动失败: ${err.message}` }));
      this.setState('dead');
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    await this.initialize();
    const thread = this.resumeNativeSessionId
      ? await this.sendRequest('thread/resume', this.threadResumeParams(this.resumeNativeSessionId))
      : await this.sendRequest('thread/start', this.threadStartParams());
    const threadObj = obj(obj(thread).thread);
    const native = str(threadObj.id) ?? this.resumeNativeSessionId;
    if (native) {
      this.threadId = native;
      this.nativeSessionId = native;
    }
    this.emit.event(createEnvelope('agent', { t: 'start' }));
    this.setState('idle', this.nativeSessionId);
    this.started = true;

    if (p.prompt) {
      this.send(p.prompt);
    }
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.sendNotification('initialized', {});
  }

  private threadStartParams(): Record<string, unknown> {
    const meta = this.params.meta ?? {};
    const appendParts = [meta.appendSystemPrompt].filter((s): s is string => Boolean(s));
    return {
      ...(meta.model ? { model: meta.model } : {}),
      cwd: this.params.cwd,
      approvalPolicy: mapApprovalPolicy(meta.permissionMode),
      sandbox: mapSandbox(meta.permissionMode),
      ...(meta.customSystemPrompt ? { baseInstructions: meta.customSystemPrompt } : {}),
      ...(appendParts.length > 0 ? { developerInstructions: appendParts.join('\n\n') } : {}),
      ephemeral: false,
      serviceName: 'code-orchestrator',
    };
  }

  private threadResumeParams(threadId: string): Record<string, unknown> {
    const meta = this.params.meta ?? {};
    const appendParts = [meta.appendSystemPrompt].filter((s): s is string => Boolean(s));
    return {
      threadId,
      ...(meta.model ? { model: meta.model } : {}),
      cwd: this.params.cwd,
      approvalPolicy: mapApprovalPolicy(meta.permissionMode),
      sandbox: mapSandbox(meta.permissionMode),
      ...(meta.customSystemPrompt ? { baseInstructions: meta.customSystemPrompt } : {}),
      ...(appendParts.length > 0 ? { developerInstructions: appendParts.join('\n\n') } : {}),
    };
  }

  private turnParams(text: string, meta?: MessageMeta): Record<string, unknown> {
    const effective = { ...(this.params.meta ?? {}), ...(meta ?? {}) };
    return {
      threadId: this.threadId,
      input: textInput(text),
      ...(effective.model ? { model: effective.model } : {}),
      ...(effective.effort ? { effort: effective.effort } : {}),
      approvalPolicy: mapApprovalPolicy(effective.permissionMode),
    };
  }

  private async startOrSteerTurn(text: string, meta?: MessageMeta): Promise<void> {
    if (!this.threadId) {
      throw new Error('Codex thread not ready');
    }
    if (this.activeTurnId && this.state === 'thinking') {
      await this.sendRequest('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: textInput(text),
      });
      return;
    }
    await this.sendRequest('turn/start', this.turnParams(text, meta));
  }

  private setState(state: SessionState, nativeSessionId?: string, usage?: SessionUsage): void {
    if (this.dead && state !== 'dead') {
      return;
    }
    if (state === 'dead') {
      this.dead = true;
    }
    if (this.state !== state || nativeSessionId || usage) {
      this.state = state;
      this.emit.state(state, nativeSessionId, usage);
    }
  }

  private sendRaw(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendNotification(method: string, params?: unknown): void {
    this.sendRaw({ method, ...(params !== undefined ? { params } : {}) });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRpcId++;
    this.sendRaw({ id, method, ...(params !== undefined ? { params } : {}) });
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
    });
  }

  private sendResponse(id: RpcId, result: unknown): void {
    this.sendRaw({ id, result });
  }

  private sendError(id: RpcId, message: string): void {
    this.sendRaw({ id, error: { code: -32603, message } });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;

    if ('id' in msg && !('method' in msg)) {
      this.onResponse(msg as unknown as RpcResponse);
      return;
    }
    const method = str(msg.method);
    if (!method) return;
    if ('id' in msg) {
      this.onServerRequest({ id: msg.id as RpcId, method, params: msg.params });
    } else {
      this.onNotification(method, msg.params);
    }
  }

  private onResponse(msg: RpcResponse): void {
    const pending = this.pendingRpc.get(msg.id);
    if (!pending) return;
    this.pendingRpc.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onServerRequest(req: RpcRequest): void {
    if (req.id === undefined) return;
    const params = obj(req.params);
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.requestApproval(req.id, req.method, params);
        return;
      case 'item/permissions/requestApproval':
        // co 的审批模型目前只覆盖具体工具/文件动作；权限扩展请求默认不授予额外权限。
        this.sendResponse(req.id, { permissions: {}, scope: 'turn' });
        return;
      case 'item/tool/requestUserInput':
        this.requestApproval(req.id, req.method, params, 'waiting_input');
        return;
      case 'mcpServer/elicitation/request':
        this.sendResponse(req.id, { action: 'decline', content: null, _meta: null });
        return;
      case 'item/tool/call':
        this.sendError(req.id, 'dynamic app-server tool calls are not implemented by code-orchestrator');
        return;
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
        this.sendError(req.id, `${req.method} is not implemented by code-orchestrator`);
        return;
      default:
        this.sendError(req.id, `unsupported Codex app-server request: ${req.method}`);
    }
  }

  private requestApproval(
    requestId: RpcId,
    method: string,
    params: Record<string, unknown>,
    state: 'waiting_approval' | 'waiting_input' = 'waiting_approval',
  ): void {
    const approvalId = createId();
    const request: ApprovalRequest = {
      id: approvalId,
      kind: 'tool',
      sessionId: this.sessionId,
      title: codexRequestTitle(method, params),
      payload: { backend: 'codex', method, params },
      requestedAt: Date.now(),
    };
    this.pendingApprovals.set(approvalId, { requestId, method });
    this.setState(state);
    this.emit.approval(request);
  }

  private respondApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return false;
    }
    this.pendingApprovals.delete(approvalId);
    const allow = decision.behavior === 'allow';
    if (pending.method === 'item/tool/requestUserInput') {
      const answers = decision.behavior === 'allow' ? obj(decision.updatedInput?.answers) : {};
      this.sendResponse(pending.requestId, { answers });
    } else if (pending.method === 'item/commandExecution/requestApproval') {
      this.sendResponse(pending.requestId, { decision: allow ? 'accept' : 'decline' });
    } else if (pending.method === 'item/fileChange/requestApproval') {
      this.sendResponse(pending.requestId, { decision: allow ? 'accept' : 'decline' });
    } else if (pending.method === 'execCommandApproval' || pending.method === 'applyPatchApproval') {
      this.sendResponse(pending.requestId, { decision: allow ? 'approved' : 'denied' });
    } else {
      this.sendError(pending.requestId, decision.behavior === 'deny' ? decision.message ?? 'approval denied' : 'approval denied');
    }
    if (this.state !== 'dead') {
      this.setState('thinking');
    }
    return true;
  }

  private onNotification(method: string, params: unknown): void {
    const p = obj(params);
    switch (method) {
      case 'thread/started': {
        const thread = obj(p.thread);
        const id = str(thread.id);
        if (id && !this.threadId) {
          this.threadId = id;
          this.nativeSessionId = id;
          if (!this.started) this.setState('idle', id);
        }
        break;
      }
      case 'turn/started': {
        const turn = obj(p.turn);
        this.activeTurnId = str(turn.id) ?? this.activeTurnId;
        this.setState('thinking');
        break;
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        this.activeTurnId = null;
        this.usage.turns += 1;
        this.emit.event(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn.status) }));
        this.setState('idle', undefined, { ...this.usage });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = obj(obj(p.tokenUsage).total);
        this.usage.inputTokens = typeof total.inputTokens === 'number' ? total.inputTokens : this.usage.inputTokens;
        this.usage.outputTokens = typeof total.outputTokens === 'number' ? total.outputTokens : this.usage.outputTokens;
        this.usage.cacheReadTokens = typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : this.usage.cacheReadTokens;
        this.setState(this.state, undefined, { ...this.usage });
        break;
      }
      case 'item/agentMessage/delta': {
        const item = str(p.itemId);
        const delta = str(p.delta);
        if (item && delta) {
          this.agentText.set(item, (this.agentText.get(item) ?? '') + delta);
        }
        break;
      }
      case 'command/exec/outputDelta':
      case 'process/outputDelta':
      case 'item/commandExecution/outputDelta': {
        const item = str(p.itemId) ?? str(p.processId);
        const delta = str(p.delta);
        if (item && delta) {
          this.toolOutput.set(item, (this.toolOutput.get(item) ?? '') + delta);
        }
        break;
      }
      case 'item/mcpToolCall/progress': {
        const item = str(p.itemId);
        const message = str(p.message);
        if (item && message) {
          this.toolOutput.set(item, `${this.toolOutput.get(item) ?? ''}${message}\n`);
        }
        break;
      }
      case 'item/started':
        this.onItemStarted(obj(p.item));
        break;
      case 'item/completed':
        this.onItemCompleted(obj(p.item));
        break;
      case 'error':
      case 'warning':
      case 'configWarning':
      case 'guardianWarning':
      case 'deprecationNotice': {
        const text = str(p.message) ?? safeJson(p);
        this.emit.event(createEnvelope('agent', { t: 'service', text: truncate(text) }));
        break;
      }
      default:
        break;
    }
  }

  private onItemStarted(item: Record<string, unknown>): void {
    const type = itemType(item);
    const id = itemId(item);
    if (type === 'commandExecution') {
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-start',
          call: id,
          name: 'command',
          title: commandTitle(item),
          description: '',
          args: { command: str(item.command) ?? '', cwd: str(item.cwd) ?? '', source: item.source ?? null },
        }),
      );
    } else if (type === 'fileChange') {
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-start',
          call: id,
          name: 'file-change',
          title: 'file change',
          description: '',
          args: { changes: item.changes ?? [] },
        }),
      );
    } else if (type === 'mcpToolCall') {
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-start',
          call: id,
          name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`,
          title: str(item.tool) ?? 'mcp tool',
          description: '',
          args: obj(item.arguments),
        }),
      );
    } else if (type === 'dynamicToolCall') {
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-start',
          call: id,
          name: str(item.tool) ?? 'tool',
          title: str(item.tool) ?? 'tool',
          description: '',
          args: obj(item.arguments),
        }),
      );
    }
  }

  private onItemCompleted(item: Record<string, unknown>): void {
    const type = itemType(item);
    const id = itemId(item);
    if (type === 'agentMessage') {
      const text = str(item.text) ?? this.agentText.get(id) ?? '';
      this.agentText.delete(id);
      if (text) {
        this.emit.event(createEnvelope('agent', { t: 'text', text }, { codexItemId: id }));
      }
      return;
    }

    if (type === 'commandExecution') {
      const output = str(item.aggregatedOutput) ?? this.toolOutput.get(id) ?? '';
      this.toolOutput.delete(id);
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-end',
          call: id,
          ...(output ? { output: truncate(output) } : {}),
          ...(item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? { isError: true } : {}),
        }),
      );
      return;
    }

    if (type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
      const output = this.toolOutput.get(id) ?? safeJson(type === 'fileChange' ? item.changes : item.result ?? item.error ?? item.contentItems ?? item.status);
      this.toolOutput.delete(id);
      this.emit.event(
        createEnvelope('agent', {
          t: 'tool-call-end',
          call: id,
          output: truncate(output),
          ...(item.error || item.success === false ? { isError: true } : {}),
        }),
      );
    }
  }
}
