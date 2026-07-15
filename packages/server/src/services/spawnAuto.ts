/**
 * 自动就位 spawn：当 POST /api/sessions 的 machineId/cwd 缺省时，
 * 根据项目上下文自动解析机器和目录，再委托 spawnSession / spawnContainerSession。
 *
 * 无轮盘赌原则：绝不在多台候选机中静默取第一台（docs/design-sessions-ui.md:51）。
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { MachineInfo, MessageMeta } from '@co/protocol';
import type { SessionAgent } from '@co/protocol';
import { getDb, hasDb, schema } from '../db/index';
import { anyForgeToken, userForgeToken } from '../forge/tokens';
import type { ForgeKind } from '../forge/types';
import { listMachines } from '../ws/runnerHub';
import { materializeWorkspace } from './materialize';
import { readyMachineIds } from './scheduler';
import type { SpawnRequest } from './spawn';
import { spawnSession, SpawnError } from './spawn';
import { spawnContainerSession, ContainerSpawnQueued } from './spawnContainer';
import { schedulableMachines } from './machineScheduling';

export interface AutoSpawnRequest {
  machineId?: string;
  cwd?: string;
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
  /** 开启容器执行（仅 baseImage 项目有效）；不传则默认 auto */
  container?: boolean;
}

async function loadProject(projectId: string) {
  if (!hasDb()) return null;
  const rows = await getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

/**
 * 无轮盘赌机器解析。
 * 严格实现 docs/design-sessions-ui.md:51 的顺序：
 *   1) 黏性：ready 物化机且在线、未暂停调度
 *   2) 标签：labels 含 'dev' 的可调度在线机
 *   3) 唯一可调度在线机
 *   4) 多台不命中 → null（不赌）
 */
export function resolveInteractiveMachine(online: MachineInfo[], readyIds: string[]): string | null {
  const schedulable = schedulableMachines(online);
  if (schedulable.length === 0) return null;

  // 黏性：ready 物化且在线
  const sticky = schedulable.find((m) => readyIds.includes(m.id));
  if (sticky) return sticky.id;

  // labels 含 dev
  const dev = schedulable.find((m) => m.labels.includes('dev'));
  if (dev) return dev.id;

  // 唯一在线机
  if (schedulable.length === 1) return schedulable[0]!.id;

  // 多台且不命中 → 需要显式选择
  return null;
}

/**
 * 编排入口：自动解析机器与目录并创建会话。
 *
 * 决策树：
 *   1) 显式透传（machineId + cwd 均给）→ 原样 spawnSession（向后兼容）
 *   2) 自动模式需要项目 → 根据 baseImage/accel 分支
 *      a) accel 项目 → 强制容器，走 spawnContainerSession（schedule 内部预留）
 *      b) 容器项目（baseImage）→ spawnContainerSession，定好的 machineId 传进去
 *      c) 非容器 → 物化目录后 spawnSession
 *
 * 可能冒泡 ContainerSpawnQueued（由路由转 202）。
 */
export async function resolveAndSpawn(req: AutoSpawnRequest): Promise<{
  sessionId: string;
  resolved?: { machineId: string; cwd: string };
  queued?: boolean;
  taskId?: string;
}> {
  const requestedMachine = req.machineId
    ? listMachines().find((machine) => machine.id === req.machineId)
    : undefined;
  if (requestedMachine?.schedulingPaused) {
    throw new SpawnError(409, `机器 ${req.machineId} 已暂停新任务调度`);
  }

  // ── 1) 显式透传（向后兼容）──
  if (req.machineId && req.cwd) {
    const r = await spawnSession(req as SpawnRequest);
    return { sessionId: r.sessionId, resolved: { machineId: req.machineId, cwd: req.cwd } };
  }

  // ── 2) 自动模式必须有项目 ──
  if (!req.projectId) {
    throw new SpawnError(400, '自动就位需要选定项目（或在「高级」中显式指定机器与目录）');
  }
  const project = await loadProject(req.projectId);
  if (!project) {
    throw new SpawnError(404, `project not found: ${req.projectId}`);
  }

  const accelKind = project.accel?.kind ?? null;
  const wantContainer: boolean = Boolean(project.baseImage) && req.container !== false;

  // ── 3) 加速器项目：强制容器 ──
  if (accelKind) {
    if (!project.baseImage) {
      throw new SpawnError(400, '加速器项目需配置 baseImage 才能容器化执行');
    }
    const r = await spawnContainerSession({
      projectId: project.id,
      sessionId: req.sessionId,
      key: req.runId ?? req.sessionId,
      prompt: req.prompt,
      agent: req.agent,
      model: req.model,
      role: req.role,
      meta: req.effort ? { ...req.meta, effort: req.effort } : req.meta,
      createdBy: req.createdBy,
      runId: req.runId,
      nodeId: req.nodeId,
      machineId: req.machineId,
    });
    return { sessionId: r.sessionId, resolved: { machineId: r.machineId, cwd: r.cwd } };
  }

  // ── 4) 非加速器：按无轮盘赌规则定机 ──
  const online = schedulableMachines(listMachines());
  const readyIds = await readyMachineIds(project.id);
  const machineId = req.machineId ?? resolveInteractiveMachine(online, readyIds);
  if (!machineId) {
    const msg =
      online.length === 0
        ? '当前无可调度的在线机器，无法创建会话'
        : '有多台可调度在线机器且无法自动判定（无 dev 标签、无就绪物化），请在「高级」中显式选择机器';
    throw new SpawnError(400, msg);
  }

  // ── 4a) 容器路径 ──
  if (wantContainer) {
    const r = await spawnContainerSession({
      projectId: project.id,
      sessionId: req.sessionId,
      key: req.runId ?? req.sessionId,
      prompt: req.prompt,
      agent: req.agent,
      model: req.model,
      role: req.role,
      meta: req.effort ? { ...req.meta, effort: req.effort } : req.meta,
      createdBy: req.createdBy,
      runId: req.runId,
      nodeId: req.nodeId,
      machineId,
    });
    return { sessionId: r.sessionId, resolved: { machineId: r.machineId, cwd: r.cwd } };
  }

  // ── 4b) 非容器路径：物化目录 → 建会话 ──
  if (req.cwd) {
    // 高级里只填了目录、没选机器 → 尊重用户目录，跳过物化
    const r = await spawnSession({ ...req, machineId, cwd: req.cwd, createdBy: req.createdBy } as SpawnRequest);
    return { sessionId: r.sessionId, resolved: { machineId, cwd: req.cwd } };
  }

  // 无显式目录：物化
  const forge = project.forge as ForgeKind;
  const token =
    (req.createdBy ? await userForgeToken(req.createdBy, forge) : undefined) ??
    (await anyForgeToken(forge));
  const sessionId = req.sessionId ?? createId();
  const ws = await materializeWorkspace({
    machineId,
    forge,
    repo: project.repo,
    key: sessionId,
    base: (project.vars?.base as string | undefined) ?? 'main',
    projectId: project.id,
    token,
  });
  const r = await spawnSession({ ...req, sessionId, machineId, cwd: ws.cwd, createdBy: req.createdBy } as SpawnRequest);
  return { sessionId: r.sessionId, resolved: { machineId, cwd: ws.cwd } };
}
