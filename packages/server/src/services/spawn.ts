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
import { callRunner } from '../ws/runnerHub';
import { decryptSecret } from './crypto';

export class SpawnError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

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
  if (!alias || alias === 'claude') {
    return {};
  }
  if (alias === 'deepseek') {
    const key = await llmKeyFor(userId, 'deepseek', process.env.DEEPSEEK_API_KEY);
    if (!key) {
      throw new SpawnError(400, 'deepseek API key 未配置（设置页绑定或 server 设 DEEPSEEK_API_KEY），无法使用 deepseek 别名');
    }
    return {
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: key },
    };
  }
  if (alias === 'glm') {
    const key = await llmKeyFor(userId, 'glm', process.env.GLM_API_KEY);
    if (!key) {
      throw new SpawnError(400, 'glm API key 未配置（设置页绑定或 server 设 GLM_API_KEY），无法使用 glm 别名');
    }
    return {
      model: process.env.GLM_MODEL ?? 'glm-4.6',
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: key },
    };
  }
  // 查询自定义 LLM 端点注册表（label 匹配）
  const endpoint = await getDb()
    .select()
    .from(schema.llmEndpoints)
    .where(eq(schema.llmEndpoints.label, alias))
    .limit(1)
    .then((rows) => rows[0]);
  if (endpoint) {
    const key = decryptSecret(endpoint.apiKeyEnc);
    return {
      model: endpoint.model,
      env: { ANTHROPIC_BASE_URL: endpoint.baseUrl, ANTHROPIC_AUTH_TOKEN: key },
    };
  }
  return { model: alias };
}

export interface SpawnRequest {
  machineId: string;
  cwd: string;
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
  const sessionId = createId();
  const agent = req.agent ?? 'claude';
  const resolved = await resolveModel(req.model, req.createdBy);
  const meta: MessageMeta = {
    ...(req.meta ?? {}),
    model: resolved.model ?? req.meta?.model ?? null,
    ...(req.effort != null ? { effort: req.effort } : {}),
  };

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
