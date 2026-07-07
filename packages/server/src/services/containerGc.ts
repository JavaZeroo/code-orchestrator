/**
 * 容器 / 卡预留回收（design-v2）：会话 dead 但容器还在（sleep 保活）+ 预留未释放 →
 * rm 容器 + 释放卡。否则泄漏的预留会永久占住机器/卡，挡住后续 NPU 调度。
 * 周期 reconcile；清空 containerId 防重复 rm。
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, hasDb, schema } from '../db/index';
import { callRunner } from '../ws/runnerHub';
import { releaseReservationForSession } from './scheduler';

const GC_INTERVAL_MS = 60_000;

async function gcOnce(): Promise<void> {
  if (!hasDb()) {
    return;
  }
  const dead = await getDb()
    .select({ id: schema.sessions.id, machineId: schema.sessions.machineId, containerId: schema.sessions.containerId })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.state, 'dead'), isNotNull(schema.sessions.containerId)));
  for (const s of dead) {
    if (s.containerId) {
      // runner 离线/容器已没 → 忽略；rm 成功即释放其占用的卡
      await callRunner(s.machineId, 'container.rm', { containerId: s.containerId, force: true }).catch(() => {});
    }
    await releaseReservationForSession(s.id).catch(() => {});
    await getDb().update(schema.sessions).set({ containerId: null }).where(eq(schema.sessions.id, s.id));
  }
}

let timer: NodeJS.Timeout | null = null;

export function startContainerGc(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => void gcOnce().catch(() => {}), GC_INTERVAL_MS);
}
