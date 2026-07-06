/**
 * 调度器（design-v2 Q4/Q9/Q11）：资源感知放置 + 机器粒度预留账本。
 * v1：一机一任务——需加速器的会话独占一台「有该 kind 且无 active 预留」的机器；
 * 黏性优先已物化(ready)的机器，否则溢出到任意空闲机；没有则返回 null（调用方入队，#33）。
 * 纯放置逻辑可单测；预留读写走 DB。
 */

import { and, eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type { Accelerator, MachineInfo } from '@co/protocol';
import { getDb, hasDb, schema } from '../db/index';
import { listMachines } from '../ws/runnerHub';
import { getAccelerator, type BindFlags } from '../resources/accelerators';

export interface ScheduleOpts {
  /** 需要的加速器 kind；null/undefined = 无需加速器（可与他人共机） */
  accelKind?: string | null;
  /** 附加 label 约束（继承现有 machine 选择器语义） */
  labels?: string[];
  /** 指定机器（覆盖调度） */
  id?: string;
  /** 归属项目：用于黏性（优先 ready 物化的机器） */
  projectId?: string;
  /** 该会话（预留归属） */
  sessionId: string;
}

export interface Scheduled {
  machineId: string;
  /** 预留 id（仅加速器路径有）；释放时用 */
  reservationId?: string;
  /** 容器绑卡参数（仅加速器路径有） */
  bindFlags?: BindFlags;
}

/** 该机上某 kind 的全部卡 index（v1 整机分配 = 全给） */
export function cardIndices(machine: MachineInfo, kind: string): number[] {
  return (machine.resources ?? []).filter((r: Accelerator) => r.kind === kind).map((r) => r.index);
}

/** 纯放置：从在线机中挑候选（满足 label + kind），free 集合由调用方给（便于单测）。 */
export function chooseMachine(
  online: MachineInfo[],
  opts: { accelKind?: string | null; labels?: string[]; id?: string; readyMachineIds?: string[]; busyMachineIds?: string[] },
): string | null {
  if (opts.id) {
    return online.some((m) => m.id === opts.id) ? opts.id : null;
  }
  const labels = opts.labels ?? [];
  const busy = new Set(opts.busyMachineIds ?? []);
  let candidates = online.filter((m) => labels.every((l) => m.labels.includes(l)));
  if (opts.accelKind) {
    // 需加速器：机器须有该 kind 且当前空闲（一机一任务）
    candidates = candidates.filter(
      (m) => (m.resources ?? []).some((r) => r.kind === opts.accelKind) && !busy.has(m.id),
    );
  }
  if (candidates.length === 0) {
    return null;
  }
  // 黏性：优先已 ready 物化的机器（省冷物化）
  const ready = new Set(opts.readyMachineIds ?? []);
  const warm = candidates.find((m) => ready.has(m.id));
  return (warm ?? candidates[0]!).id;
}

async function activeMachineIds(): Promise<string[]> {
  if (!hasDb()) {
    return [];
  }
  const rows = await getDb()
    .select({ machineId: schema.resourceReservations.machineId })
    .from(schema.resourceReservations)
    .where(eq(schema.resourceReservations.status, 'active'));
  return rows.map((r) => r.machineId);
}

async function readyMachineIds(projectId?: string): Promise<string[]> {
  if (!hasDb() || !projectId) {
    return [];
  }
  const rows = await getDb()
    .select({ machineId: schema.projectMaterializations.machineId })
    .from(schema.projectMaterializations)
    .where(
      and(
        eq(schema.projectMaterializations.projectId, projectId),
        eq(schema.projectMaterializations.status, 'ready'),
      ),
    );
  return rows.map((r) => r.machineId);
}

/**
 * 放置 + 预留（加速器路径原子化）。返回 null = 当前无可用机器（调用方入队 task_queue）。
 * 无加速器需求时不占预留（可共机）。
 */
export async function schedule(opts: ScheduleOpts): Promise<Scheduled | null> {
  const online = listMachines();
  const ready = await readyMachineIds(opts.projectId);

  // 无加速器：纯放置，不预留
  if (!opts.accelKind) {
    const machineId = chooseMachine(online, { labels: opts.labels, id: opts.id, readyMachineIds: ready });
    return machineId ? { machineId } : null;
  }

  // 加速器路径：挑空闲机 + 原子预留（事务内二次校验，避免 TOCTOU）
  if (!hasDb()) {
    return null;
  }
  const kind = opts.accelKind;
  return getDb().transaction(async (tx) => {
    const busyRows = await tx
      .select({ machineId: schema.resourceReservations.machineId })
      .from(schema.resourceReservations)
      .where(eq(schema.resourceReservations.status, 'active'));
    const busy = busyRows.map((r) => r.machineId);
    const machineId = chooseMachine(online, { accelKind: kind, labels: opts.labels, id: opts.id, readyMachineIds: ready, busyMachineIds: busy });
    if (!machineId) {
      return null;
    }
    const machine = online.find((m) => m.id === machineId)!;
    const reservationId = createId();
    await tx.insert(schema.resourceReservations).values({
      id: reservationId,
      machineId,
      sessionId: opts.sessionId,
      kind,
      status: 'active',
      acquiredAt: new Date(),
    });
    const adapter = getAccelerator(kind);
    const bindFlags = adapter ? adapter.bindFlags(cardIndices(machine, kind)) : undefined;
    return { machineId, reservationId, bindFlags };
  });
}

/** 释放某会话的预留（容器销毁时调用，Q11：容器生命周期=卡预留）。 */
export async function releaseReservationForSession(sessionId: string): Promise<void> {
  if (!hasDb()) {
    return;
  }
  await getDb()
    .update(schema.resourceReservations)
    .set({ status: 'released', releasedAt: new Date() })
    .where(and(eq(schema.resourceReservations.sessionId, sessionId), eq(schema.resourceReservations.status, 'active')));
}

/**
 * 重启对账（Q4）：把「归属会话已消亡」的 active 预留释放——真相以存活会话为准。
 * co-server 启动时调用，防止旧预留永久占机。
 */
export async function reconcileReservations(): Promise<number> {
  if (!hasDb()) {
    return 0;
  }
  const actives = await getDb()
    .select({ id: schema.resourceReservations.id, sessionId: schema.resourceReservations.sessionId })
    .from(schema.resourceReservations)
    .where(eq(schema.resourceReservations.status, 'active'));
  let released = 0;
  for (const r of actives) {
    if (!r.sessionId) {
      continue;
    }
    const sess = await getDb()
      .select({ state: schema.sessions.state })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, r.sessionId))
      .limit(1);
    const gone = sess.length === 0 || sess[0]!.state === 'dead';
    if (gone) {
      await getDb()
        .update(schema.resourceReservations)
        .set({ status: 'released', releasedAt: new Date() })
        .where(eq(schema.resourceReservations.id, r.id));
      released += 1;
    }
  }
  return released;
}
