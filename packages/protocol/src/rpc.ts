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
      /** 任务受理会话：注入 emit_task_plan + emit_workflow 工具（in-process MCP） */
      taskIntake: z.boolean().optional(),
      /** 容器化会话（design-v2 #37）：非空则 agent 跑在该容器内（docker exec 挂载的 node+agent.mjs），
       *  而非宿主进程内起 SDK。容器由 container.run 预先创建。 */
      container: z
        .object({
          containerId: z.string(),
          nodePath: z.string(),
          agentMjs: z.string(),
        })
        .optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      nativeSessionId: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  /** 在原 runner 上重新接入已持久化的原生会话；仅宿主 Claude/Codex 会话支持 */
  'session.resume': {
    params: z.object({
      sessionId: z.string(),
      agent: z.enum(['claude', 'codex']),
      cwd: z.string(),
      nativeSessionId: z.string().min(1),
      /** 重新解析后的模型/权限配置；原生会话历史仍由 nativeSessionId 恢复 */
      meta: MessageMetaSchema.optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** 从已持久化的宿主原生会话复制完整历史，并在同一 runner 拉起独立会话 */
  'session.fork': {
    params: z
      .object({
        sourceSessionId: z.string(),
        sessionId: z.string(),
        agent: z.enum(['claude', 'codex']),
        cwd: z.string(),
        nativeSessionId: z.string().min(1),
        meta: MessageMetaSchema.optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
      .refine((params) => params.sourceSessionId !== params.sessionId, {
        message: 'fork target session must differ from source session',
        path: ['sessionId'],
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
  /** 打断当前回合（会话保留，回到 idle） */
  'session.interrupt': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
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
  /** Read one regular file beneath a session workspace. Payloads are capped at 10 MiB. */
  'workspace.read': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      basename: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
      data: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  /** Archive one directory beneath a session workspace as a bounded gzip-compressed tar payload. */
  'workspace.archive': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      basename: z.string().optional(),
      size: z.number().int().nonnegative().max(10 * 1024 * 1024).optional(),
      data: z.string().max(14 * 1024 * 1024)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
      error: z.string().optional(),
    }),
  },
  /** Write one bounded regular file beneath a session workspace. Payloads are capped at 10 MiB. */
  'workspace.write': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      data: z.string().max(14 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      size: z.number().int().nonnegative().max(10 * 1024 * 1024),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      size: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
  },
  /** Delete one regular file or empty directory beneath a session workspace without following symlinks. */
  'workspace.delete': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  },
  /** Create one directory beneath a session workspace without following escaped symlinks. */
  'workspace.mkdir': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  },
  /** Rename one regular file or directory within its current workspace directory. */
  'workspace.rename': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      newName: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      path: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  /** Move one regular file or directory to another existing workspace directory without overwriting. */
  'workspace.move': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      destinationPath: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      path: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  /** Copy one regular file or directory tree to a new workspace path without overwriting. */
  'workspace.copy': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().min(1),
      destinationPath: z.string().min(1),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      path: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  /** List one directory beneath a session workspace. Responses are capped and never follow escaped symlinks. */
  'workspace.list': {
    params: z.object({
      root: z.string().min(1),
      path: z.string().default(''),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      path: z.string().optional(),
      entries: z.array(z.object({
        name: z.string().min(1),
        type: z.enum(['file', 'directory']),
        size: z.number().int().nonnegative().optional(),
      })).optional(),
      truncated: z.boolean().optional(),
      error: z.string().optional(),
    }),
  },
  /** Recursively search filenames beneath a session workspace. Responses and traversal are bounded. */
  'workspace.search': {
    params: z.object({
      root: z.string().min(1),
      query: z.string().trim().min(1).max(100),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      matches: z.array(z.object({
        path: z.string().min(1),
        type: z.enum(['file', 'directory']),
        size: z.number().int().nonnegative().optional(),
      })).max(100).optional(),
      truncated: z.boolean().optional(),
      error: z.string().optional(),
    }),
  },
  /** Search literal text inside workspace files without following symlinks. */
  'workspace.searchContent': {
    params: z.object({
      root: z.string().min(1),
      query: z.string().trim().min(1).max(100),
      containerId: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      matches: z.array(z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        preview: z.string().max(300),
      })).max(100).optional(),
      truncated: z.boolean().optional(),
      error: z.string().optional(),
    }),
  },
  /** 容器生命周期（design-v2 Q3，M1 substrate）：co 拥有容器——起/执行/销毁。
   *  devices/gpus 由 accelerator 适配器在 M2 填充（Ascend → --device 列表；卡在建容器时绑定）。 */
  'container.run': {
    params: z.object({
      image: z.string(),
      name: z.string().optional(),
      workdir: z.string().optional(),
      /** 卷挂载：worktree→/workspace、memory 卷、out 卷 */
      mounts: z.array(z.object({ host: z.string(), container: z.string(), ro: z.boolean().optional() })).default([]),
      /** 环境变量注入（forge/LLM token，Q10） */
      env: z.record(z.string(), z.string()).optional(),
      /** 设备绑定（Ascend：/dev/davinci* 等；M2 由适配器 bindFlags 产出） */
      devices: z.array(z.string()).default([]),
      /** NVIDIA --gpus 值（如 '"device=0,1"'）；与 devices 二选一按 kind */
      gpus: z.string().optional(),
      network: z.string().optional(),
      /** 追加原样 docker run 参数（逃生舱） */
      extraArgs: z.array(z.string()).default([]),
      /** 容器主命令；缺省用镜像 CMD（常留守护，agent 经 container.exec 进入） */
      command: z.array(z.string()).optional(),
    }),
    result: z.object({ ok: z.boolean(), containerId: z.string().optional(), error: z.string().optional() }),
  },
  'container.exec': {
    params: z.object({
      containerId: z.string(),
      cmd: z.string(),
      workdir: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    result: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }),
  },
  'container.rm': {
    params: z.object({ containerId: z.string(), force: z.boolean().default(true) }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** 工作区物化（design-v2 M1）：在【目标 runner】的数据盘上 clone base + 切 worktree，
   *  取代原 server-local 供给。cloneUrl 由 server 计算（可内嵌 token，Q10 注入可接受）。 */
  'workspace.provision': {
    params: z.object({
      forge: z.string(),
      repo: z.string(),
      /** 唯一稳定键（issue number / runId / sessionId），决定分支名与 worktree 目录 */
      key: z.string(),
      base: z.string().default('main'),
      /** server 计算的 clone URL（含 host，可含 token） */
      cloneUrl: z.string(),
      gitProxy: z.string().optional(),
      /** 是否在 worktree 内 pnpm install（本地 critic 用；容器模型下通常留给容器内做） */
      installDeps: z.boolean().default(false),
      gitName: z.string().optional(),
      gitEmail: z.string().optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      /** worktree 路径（= 容器内 /workspace 的宿主机源） */
      cwd: z.string().optional(),
      branch: z.string().optional(),
      /** base 克隆路径（project_materializations.basePath） */
      basePath: z.string().optional(),
      error: z.string().optional(),
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
      /** 本机组件缓存扫描结果：{cann:["9.0.0",...]}（<dataRoot>/co/cache/ 两级目录） */
      componentCache: z.record(z.string(), z.array(z.string())).optional(),
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
      /** 会话累计用量（每回合 result 后更新） */
      usage: z
        .object({
          inputTokens: z.number(),
          outputTokens: z.number(),
          cacheReadTokens: z.number(),
          costUsd: z.number(),
          turns: z.number(),
        })
        .optional(),
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
  /** taskIntake 会话的 emit_task_plan 工具产出（server 校验后广播任务计划事件） */
  'task.plan': {
    params: z.object({ sessionId: z.string(), plan: z.object({ defId: z.string(), vars: z.record(z.string(), z.string()), summary: z.string() }) }),
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
