/**
 * 容器化会话编排（design-v2 Q1/Q3/Q9/Q11，M1 #31）：把 M1/M2 的积木串起来——
 *   schedule（挑机+预留）→ materialize（目标机物化 worktree）→ container.run（绑卡起容器）→ 起 agent。
 *
 * 非破坏 opt-in：只有【配了 baseImage 的项目】走这条路；存量 forge+repo 项目 / 手动会话仍走 spawn.ts。
 * 未接线到任何 live 路由——供 #31 的调度队列 dispatch 与将来路由调用。
 *
 * 「起 agent 于容器内」(#37) 是唯一注入的 seam：driver 未接时清理回滚 + 明确报错，绝不留半吊子会话。
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { getDb, hasDb, schema } from '../db/index';
import { publish } from '../events';
import { anyForgeToken, userForgeToken } from '../forge/tokens';
import type { ForgeKind } from '../forge/types';
import { callRunner } from '../ws/runnerHub';
import { materializeWorkspace } from './materialize';
import { releaseReservationForSession, schedule } from './scheduler';
import { resolveModel } from './spawn';
import { enqueueTask, type DispatchResult, type QueuedTask } from './taskQueue';

/** 容器内项目根（design-v2 Q6）：worktree 恒挂此处，agent 的 cwd */
const WORKSPACE = '/workspace';

export interface ContainerSpawnRequest {
  projectId: string;
  /** 唯一稳定键（issue number / runId / 自生成） */
  key?: string;
  prompt?: string;
  model?: string;
  role?: string;
  createdBy?: string;
  runId?: string;
  nodeId?: string;
  base?: string;
}

/** #37 seam：把 agent 起在容器内（其 bash 见训练环境）。由 agent-in-container driver 实现。 */
export interface ContainerAgentContext {
  sessionId: string;
  machineId: string;
  containerId: string;
  workdir: string;
  env: Record<string, string>;
  prompt?: string;
  model?: string;
}
export type StartAgentInContainer = (ctx: ContainerAgentContext) => Promise<void>;

async function loadProject(projectId: string) {
  if (!hasDb()) {
    return null;
  }
  const rows = await getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

export class ContainerSpawnQueued extends Error {
  constructor(readonly taskId: string) {
    super('no capacity — queued');
  }
}

/**
 * 编排一个容器化会话。无空闲机 → 入队并抛 ContainerSpawnQueued（调用方据此返回 202/排队态）。
 * startAgent 未提供或失败 → 回滚（rm 容器 + 释放预留 + 标 dead）后抛错。
 */
export async function spawnContainerSession(
  req: ContainerSpawnRequest,
  startAgent?: StartAgentInContainer,
  opts: { alreadyQueued?: boolean } = {},
): Promise<{ sessionId: string }> {
  const project = await loadProject(req.projectId);
  if (!project) {
    throw new Error(`project not found: ${req.projectId}`);
  }
  if (!project.baseImage) {
    throw new Error(`project ${project.name} 未配 baseImage——非容器化项目应走 spawn.ts`);
  }
  const forge = project.forge as ForgeKind;
  const sessionId = createId();
  const key = req.key ?? sessionId;
  const accelKind = project.accel?.kind ?? null;

  // 1) 放置 + 预留（加速器路径原子占机）；无机则入队（已在队列中的重试不重复入队）
  const placed = await schedule({ accelKind, projectId: req.projectId, sessionId });
  if (!placed) {
    if (opts.alreadyQueued) {
      throw new ContainerSpawnQueued('');
    }
    const taskId = await enqueueTask({
      projectId: req.projectId,
      kind: accelKind ?? undefined,
      payload: { ...req, key } as unknown as Record<string, unknown>,
    });
    throw new ContainerSpawnQueued(taskId);
  }
  const { machineId, reservationId, bindFlags } = placed;

  try {
    // 2) 目标机物化 worktree（Q10：clone URL 内嵌 token）
    const token = (req.createdBy ? await userForgeToken(req.createdBy, forge) : undefined) ?? (await anyForgeToken(forge));
    const ws = await materializeWorkspace({
      machineId,
      forge,
      repo: project.repo,
      key,
      base: req.base ?? (project.vars?.base as string | undefined) ?? 'main',
      projectId: req.projectId,
      token,
    });

    // 3) 组装容器环境：模型端点 + forge token（Q10 注入）+ 项目 vars
    const resolved = await resolveModel(req.model, req.createdBy);
    const containerEnv: Record<string, string> = { ...(resolved.env ?? {}), ...(bindFlags?.env ?? {}) };
    if (token) {
      containerEnv.GH_TOKEN = token;
      containerEnv.GIT_ASKPASS = 'true';
    }

    // 4) 起容器（绑卡）
    const runRes = await callRunner(machineId, 'container.run', {
      image: project.baseImage,
      name: `co-${sessionId.slice(0, 12)}`,
      workdir: WORKSPACE,
      mounts: [{ host: ws.cwd, container: WORKSPACE }],
      env: containerEnv,
      devices: bindFlags?.devices ?? [],
      gpus: bindFlags?.gpus,
      extraArgs: [],
    });
    if (!runRes.ok || !runRes.containerId) {
      throw new Error(`container.run failed @ ${machineId}: ${runRes.error ?? 'unknown'}`);
    }
    const containerId = runRes.containerId;

    // 5) 记录会话
    if (hasDb()) {
      await getDb().insert(schema.sessions).values({
        id: sessionId,
        machineId,
        agent: 'claude',
        model: resolved.model ?? req.model,
        role: req.role,
        cwd: WORKSPACE,
        state: 'starting',
        runId: req.runId,
        nodeId: req.nodeId,
        projectId: req.projectId,
        containerId,
        reservationId,
        createdBy: req.createdBy,
      });
    }

    // 6) 起 agent 于容器内（#37 seam）
    if (!startAgent) {
      throw new Error('agent-in-container driver 未接线（#37）');
    }
    await startAgent({ sessionId, machineId, containerId, workdir: WORKSPACE, env: containerEnv, prompt: req.prompt, model: resolved.model ?? req.model });

    await publish({ type: 'session.created', sessionId, runId: req.runId, payload: { machineId, cwd: WORKSPACE, projectId: req.projectId, containerId } });
    return { sessionId };
  } catch (err) {
    // 回滚：释放预留 + 标 dead（容器由 runner 侧或后续 GC 清理；此处尽力）
    await releaseReservationForSession(sessionId).catch(() => {});
    if (hasDb()) {
      await getDb().update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, sessionId)).catch(() => {});
    }
    throw err;
  }
}

/** 调度队列 dispatch（design-v2 Q9）：把一个 pending 任务真正派发。供 startQueueReconciler 注入。 */
export function makeContainerDispatch(startAgent?: StartAgentInContainer) {
  return async function dispatch(task: QueuedTask): Promise<DispatchResult> {
    const req = task.payload as unknown as ContainerSpawnRequest;
    try {
      await spawnContainerSession(req, startAgent, { alreadyQueued: true });
      return 'started';
    } catch (err) {
      if (err instanceof ContainerSpawnQueued) {
        return 'no-capacity'; // 仍无机，保持 pending
      }
      console.error('[dispatch] 派发失败:', err instanceof Error ? err.message : err);
      return 'failed';
    }
  };
}
