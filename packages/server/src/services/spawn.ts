/**
 * 会话创建服务：REST 路由与工作流引擎共用。
 * 模型别名在此解析为 SDK model + Anthropic 兼容端点 env 注入（CLI×模型解耦落点）。
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { MessageMeta, SessionAgent } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { publish } from '../events';
import { callRunner } from '../ws/runnerHub';

export class SpawnError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** 别名 → 模型名 + env。密钥从 server 环境读（DEEPSEEK_API_KEY / GLM_API_KEY）。 */
export function resolveModel(alias?: string): { model?: string; env?: Record<string, string> } {
  if (!alias || alias === 'claude') {
    return {};
  }
  if (alias === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new SpawnError(400, 'DEEPSEEK_API_KEY 未配置，无法使用 deepseek 别名');
    }
    return {
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: key },
    };
  }
  if (alias === 'glm') {
    const key = process.env.GLM_API_KEY;
    if (!key) {
      throw new SpawnError(400, 'GLM_API_KEY 未配置，无法使用 glm 别名');
    }
    return {
      model: process.env.GLM_MODEL ?? 'glm-4.6',
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: key },
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
  runId?: string;
  nodeId?: string;
  createdBy?: string;
}

export async function spawnSession(req: SpawnRequest): Promise<{ sessionId: string }> {
  const sessionId = createId();
  const agent = req.agent ?? 'claude';
  const resolved = resolveModel(req.model);
  const meta: MessageMeta = { ...(req.meta ?? {}), model: resolved.model ?? req.meta?.model ?? null };

  const db = getDb();
  await db.insert(schema.sessions).values({
    id: sessionId,
    machineId: req.machineId,
    agent,
    model: resolved.model ?? req.model,
    role: req.role,
    cwd: req.cwd,
    state: 'starting',
    runId: req.runId,
    nodeId: req.nodeId,
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
