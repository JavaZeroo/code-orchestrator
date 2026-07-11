/**
 * 统一「等我处理」选择器 —— 单一事实源。
 * 复用看板现有的同一批信号（waiting_approval 会话 + waiting_human run），
 * 只是改成按线程聚合。禁止另造一套。
 */

import type { SessionRow, RunRow, ProjectRow } from '../api';
import { runDisplayTitle } from './runTitle';

/** 会话线程 waiting ⇔ state === 'waiting_approval' || state === 'waiting_input' */
export function isWaitingSession(s: SessionRow): boolean {
  return s.state === 'waiting_approval' || s.state === 'waiting_input';
}

/** run 线程 waiting ⇔ status === 'waiting_human' */
export function isWaitingRun(r: RunRow): boolean {
  return r.status === 'waiting_human';
}

/** 线程归属项目：会话 → 自身 projectId，否则经其 run 归属 */
export function threadProjectId(s: SessionRow, runMap: Map<string, RunRow>): string | null {
  return s.projectId ?? (s.runId ? runMap.get(s.runId)?.projectId ?? null : null);
}

/** 按项目 waiting 线程数（供切换器红点+计数） */
export function waitingCountByProject(
  sessions: SessionRow[],
  runs: RunRow[],
): Map<string, number> {
  const runMap = new Map(runs.map((r) => [r.id, r]));
  const count = new Map<string, number>();
  for (const s of sessions) {
    if (!isWaitingSession(s)) continue;
    const pid = threadProjectId(s, runMap);
    if (pid) count.set(pid, (count.get(pid) ?? 0) + 1);
  }
  for (const r of runs) {
    if (!isWaitingRun(r) || !r.projectId) continue;
    count.set(r.projectId, (count.get(r.projectId) ?? 0) + 1);
  }
  return count;
}

/** 跨项目 waiting 线程归一化列表（供铃铛） */
export interface AttentionItem {
  kind: 'session' | 'run';
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  subtitle: string;
}

export function crossProjectWaiting(
  sessions: SessionRow[],
  runs: RunRow[],
  projects: ProjectRow[],
): AttentionItem[] {
  const projMap = new Map(projects.map((p) => [p.id, p]));
  const runMap = new Map(runs.map((r) => [r.id, r]));
  const items: AttentionItem[] = [];

  for (const s of sessions) {
    if (!isWaitingSession(s)) continue;
    const pid = threadProjectId(s, runMap);
    if (!pid) continue;
    items.push({
      kind: 'session',
      id: s.id,
      projectId: pid,
      projectName: projMap.get(pid)?.name ?? pid,
      title: s.title ?? (s.cwd.split('/').pop() || s.cwd),
      subtitle: '等待处理',
    });
  }

  for (const r of runs) {
    if (!isWaitingRun(r) || !r.projectId) continue;
    items.push({
      kind: 'run',
      id: r.id,
      projectId: r.projectId,
      projectName: projMap.get(r.projectId)?.name ?? r.projectId,
      title: runDisplayTitle(r),
      subtitle: '流水线等待审批',
    });
  }

  return items;
}
