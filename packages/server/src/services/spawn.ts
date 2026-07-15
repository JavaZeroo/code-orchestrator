/**
 * 会话创建服务：REST 路由与工作流引擎共用。
 * 模型别名在此解析为 SDK model + Anthropic 兼容端点 env 注入（CLI×模型解耦落点）。
 */

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { MessageMeta, SessionAgent } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { env } from '../env';
import { publish } from '../events';
import { callRunner, listMachines } from '../ws/runnerHub';
import { decryptSecret } from './crypto';
import { isMachineSchedulable } from './machineScheduling';
import { buildInjectedEnv, planModel, SpawnError } from './modelResolve';

// Re-export SpawnError for callers importing from './spawn'
export { SpawnError } from './modelResolve';

/** 请求者本人绑定的 LLM key（llm_keys 表，AES-256-GCM）；无用户上下文/未绑定时返回 undefined */
async function userLlmKey(userId: string | undefined, provider: 'deepseek' | 'glm'): Promise<string | undefined> {
  if (!userId || !env.AUTH_SECRET) {
    return undefined;
  }
  const rows = await getDb()
    .select({ enc: schema.llmKeys.keyEnc })
    .from(schema.llmKeys)
    .where(and(eq(schema.llmKeys.userId, userId), eq(schema.llmKeys.provider, provider)))
    .limit(1);
  return rows[0]?.enc ? decryptSecret(rows[0].enc) : undefined;
}

/** 任一已绑定用户的 LLM key（工作流会话无用户上下文时兜底，单租户可用；类比 anyForgeToken） */
async function anyLlmKey(provider: 'deepseek' | 'glm'): Promise<string | undefined> {
  if (!env.AUTH_SECRET) {
    return undefined;
  }
  const rows = await getDb()
    .select({ enc: schema.llmKeys.keyEnc })
    .from(schema.llmKeys)
    .where(eq(schema.llmKeys.provider, provider))
    .limit(1);
  return rows[0]?.enc ? decryptSecret(rows[0].enc) : undefined;
}

/** key 解析：请求者本人 → 任一已绑定用户（工作流会话兜底）→ server 环境变量 */
async function llmKeyFor(userId: string | undefined, provider: 'deepseek' | 'glm', envKey?: string): Promise<string | undefined> {
  return (await userLlmKey(userId, provider)) ?? (await anyLlmKey(provider)) ?? envKey;
}

/** 别名 → 模型名 + env。密钥优先用当前用户绑定的（设置页），再回落任一绑定 / server 环境变量。 */
export async function resolveModel(
  alias?: string,
  userId?: string,
): Promise<{ model?: string; env?: Record<string, string> }> {
  // 1) 拉全部 providers（小表，一次 select）
  const providerRows = await getDb().select().from(schema.llmProviders);
  const snapshots = providerRows.map((r) => ({
    name: r.name,
    baseUrl: r.baseUrl,
    models: r.models,
    defaultModel: r.defaultModel,
    apiKeyEnc: r.apiKeyEnc,
  }));

  // 2) 纯函数决策
  const plan = planModel(alias, snapshots);

  // 3) inject:false 分支——无 env 直接返回
  if (!plan.inject) {
    return { model: plan.model };
  }

  // 4) inject:true 分支——解析 key
  const row = snapshots.find((p) => p.name === plan.provider)!;
  let key: string | undefined;
  if (row.apiKeyEnc) {
    try {
      key = decryptSecret(row.apiKeyEnc);
    } catch {
      // 解密失败的视为无 key，走回落链
    }
  }

  // deepseek/glm 回落链
  if (!key && (plan.provider === 'deepseek' || plan.provider === 'glm')) {
    key = await llmKeyFor(
      userId,
      plan.provider as 'deepseek' | 'glm',
      process.env[plan.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GLM_API_KEY'],
    );
  }

  // 可选：env 覆盖 model（deepseek/glm 设了 DEEPSEEK_MODEL/GLM_MODEL 则覆盖）
  if (plan.provider === 'deepseek' && process.env.DEEPSEEK_MODEL) {
    plan.model = process.env.DEEPSEEK_MODEL;
  }
  if (plan.provider === 'glm' && process.env.GLM_MODEL) {
    plan.model = process.env.GLM_MODEL;
  }

  return buildInjectedEnv(plan, key);
}

export interface SpawnRequest {
  machineId: string;
  cwd: string;
  sessionId?: string;
  prompt?: string;
  agent?: SessionAgent;
  model?: string;
  role?: string;
  meta?: MessageMeta;
  env?: Record<string, string>;
  designer?: boolean;
  taskIntake?: boolean;
  title?: string;
  runId?: string;
  nodeId?: string;
  createdBy?: string;
  projectId?: string;
  effort?: MessageMeta['effort'];
}

export async function spawnSession(req: SpawnRequest): Promise<{ sessionId: string }> {
  const target = listMachines().find((machine) => machine.id === req.machineId);
  if (target && !isMachineSchedulable(target)) {
    throw new SpawnError(409, `机器 ${req.machineId} 已暂停新任务调度`);
  }

  const sessionId = req.sessionId ?? createId();
  const agent = req.agent ?? 'claude';
  const resolved = await resolveModel(req.model, req.createdBy);
  const meta: MessageMeta = {
    ...(req.meta ?? {}),
    model: resolved.model ?? req.meta?.model ?? null,
    ...(req.effort != null ? { effort: req.effort } : {}),
  };
  // 手动会话（非工作流节点）默认全自动放行：会话跑在专属 worktree/容器里，
  // 逐工具审批只会把人变成瓶颈；工作流节点仍由 node.permissionMode 显式控制
  if (!req.runId && meta.permissionMode == null) {
    meta.permissionMode = 'bypassPermissions';
  }

  const title =
    req.title ??
    (req.designer ? '对话式搭建工作流'
     : req.taskIntake ? '新建任务对话'
     : req.nodeId ? `run节点 · ${req.nodeId}`
     : null);

  const db = getDb();
  await db.insert(schema.sessions).values({
    id: sessionId,
    machineId: req.machineId,
    agent,
    model: resolved.model ?? req.model,
    role: req.role,
    cwd: req.cwd,
    title,
    state: 'starting',
    runId: req.runId,
    nodeId: req.nodeId,
    projectId: req.projectId,
    createdBy: req.createdBy,
  });

  const result = await callRunner(req.machineId, 'session.spawn', {
    sessionId,
    agent,
    cwd: req.cwd,
    prompt: req.prompt,
    runId: req.runId,
    nodeId: req.nodeId,
    meta,
    env: { ...(resolved.env ?? {}), ...(req.env ?? {}) },
    designer: req.designer,
    taskIntake: req.taskIntake,
  });
  if (!result.ok) {
    await db.update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, sessionId));
    throw new SpawnError(502, result.error ?? 'spawn failed');
  }
  await publish({
    type: 'session.created',
    sessionId,
    runId: req.runId,
    payload: { machineId: req.machineId, cwd: req.cwd, runId: req.runId, nodeId: req.nodeId },
  });
  return { sessionId };
}
