/**
 * 任务排队（design-v2 Q9）：需加速器的任务在无空闲机时进 pending；
 * 机器释放后 reconciler 按 FIFO+priority 自动派发——兑现「你只管提任务，有资源就自动跑」。
 * dispatch 由 #31（spawn 集成）注入：真正去 schedule+物化+起容器+起 agent。
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { getDb, hasDb, schema } from '../db/index';

const RECONCILE_INTERVAL_MS = 10_000;

export interface EnqueueOpts {
  projectId?: string;
  kind?: string;
  /** 派发时 spawn 所需的一切（cwd/prompt/model/role/env 等由 #31 定义并消费） */
  payload: Record<string, unknown>;
  priority?: number;
}

export interface QueuedTask {
  id: string;
  projectId: string | null;
  kind: string | null;
  payload: Record<string, unknown>;
  priority: number;
  enqueuedAt: Date;
}

export type TaskQueueStatus = 'pending' | 'scheduled' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskQueueStore {
  listPending(projectId?: string): Promise<QueuedTask[]>;
  transition(id: string, from: TaskQueueStatus, to: TaskQueueStatus, projectId?: string): Promise<boolean>;
  find(id: string, projectId?: string): Promise<{ status: TaskQueueStatus } | null>;
}

/** dispatch 结果：'started'=已起；'no-capacity'=当前无机（保持 pending，本轮停）；'failed'=派发失败 */
export type DispatchResult = 'started' | 'no-capacity' | 'failed';

export async function enqueueTask(opts: EnqueueOpts): Promise<string> {
  const id = createId();
  if (hasDb()) {
    await getDb().insert(schema.taskQueue).values({
      id,
      projectId: opts.projectId ?? null,
      kind: opts.kind ?? null,
      payload: opts.payload,
      priority: opts.priority ?? 0,
      status: 'pending',
    });
  }
  return id;
}

const databaseQueueStore: TaskQueueStore = {
  async listPending(projectId) {
    if (!hasDb()) {
      return [];
    }
    const pending = eq(schema.taskQueue.status, 'pending');
    const rows = await getDb()
      .select()
      .from(schema.taskQueue)
      .where(projectId ? and(pending, eq(schema.taskQueue.projectId, projectId)) : pending)
      .orderBy(desc(schema.taskQueue.priority), asc(schema.taskQueue.enqueuedAt));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      kind: r.kind,
      payload: r.payload,
      priority: r.priority,
      enqueuedAt: r.enqueuedAt,
    }));
  },

  async transition(id, from, to, projectId) {
    if (!hasDb()) {
      return false;
    }
    const match = and(
      eq(schema.taskQueue.id, id),
      eq(schema.taskQueue.status, from),
      ...(projectId ? [eq(schema.taskQueue.projectId, projectId)] : []),
    );
    const rows = await getDb()
      .update(schema.taskQueue)
      .set({ status: to })
      .where(match)
      .returning({ id: schema.taskQueue.id });
    return rows.length === 1;
  },

  async find(id, projectId) {
    if (!hasDb()) {
      return null;
    }
    const match = and(
      eq(schema.taskQueue.id, id),
      ...(projectId ? [eq(schema.taskQueue.projectId, projectId)] : []),
    );
    const rows = await getDb()
      .select({ status: schema.taskQueue.status })
      .from(schema.taskQueue)
      .where(match)
      .limit(1);
    return rows[0] ?? null;
  },
};

export async function listQueuedTasks(projectId: string, store: TaskQueueStore = databaseQueueStore): Promise<QueuedTask[]> {
  return store.listPending(projectId);
}

export type CancelQueuedTaskResult =
  | { outcome: 'cancelled' }
  | { outcome: 'not-found' }
  | { outcome: 'conflict'; status: TaskQueueStatus };

/** pending→cancelled 的 compare-and-set：与 reconciler 的 pending→scheduled claim 只能有一个成功。 */
export async function cancelQueuedTask(
  projectId: string,
  id: string,
  store: TaskQueueStore = databaseQueueStore,
): Promise<CancelQueuedTaskResult> {
  if (await store.transition(id, 'pending', 'cancelled', projectId)) {
    return { outcome: 'cancelled' };
  }
  const existing = await store.find(id, projectId);
  return existing ? { outcome: 'conflict', status: existing.status } : { outcome: 'not-found' };
}

async function setStatus(id: string, status: TaskQueueStatus): Promise<void> {
  if (hasDb()) {
    await getDb().update(schema.taskQueue).set({ status }).where(eq(schema.taskQueue.id, id));
  }
}

export const markTaskRunning = (id: string) => setStatus(id, 'running');
export const markTaskDone = (id: string) => setStatus(id, 'done');
export const markTaskFailed = (id: string) => setStatus(id, 'failed');

/** 单次后台 tick，单独导出以便用真实 Postgres 做确定性的 ST。 */
export async function reconcileQueueOnce(
  dispatch: (task: QueuedTask) => Promise<DispatchResult>,
  store: TaskQueueStore = databaseQueueStore,
  now = Date.now(),
): Promise<void> {
  const pending = await store.listPending();
  // 过期回收：排队超 24h 的任务多半已失去意义（用户早走了/需求变了），标 failed 防止永久占着「排队中」
  const MAX_PENDING_AGE_MS = 24 * 3600_000;
  const fresh: typeof pending = [];
  for (const task of pending) {
    if (now - new Date(task.enqueuedAt).getTime() > MAX_PENDING_AGE_MS) {
      if (await store.transition(task.id, 'pending', 'failed')) {
        console.warn(`[queue] 任务 ${task.id} 排队超 24h，标记过期`);
      }
    } else {
      fresh.push(task);
    }
  }
  for (const task of fresh) {
    // stale list 不足以派发；必须先原子 claim。若取消先赢，这里返回 false 且绝不调用 dispatch。
    if (!(await store.transition(task.id, 'pending', 'scheduled'))) {
      continue;
    }
    let res: DispatchResult;
    try {
      res = await dispatch(task);
    } catch (err) {
      await store.transition(task.id, 'scheduled', 'failed');
      console.error('[taskQueue] dispatch failed:', err instanceof Error ? err.message : err);
      continue;
    }
    if (res === 'no-capacity') {
      await store.transition(task.id, 'scheduled', 'pending');
      break; // 机器满，保持其余 pending，下轮再试
    }
    await store.transition(task.id, 'scheduled', res === 'started' ? 'running' : 'failed');
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * 启动排队 reconciler。dispatch 尝试真正派发一个任务：
 * 返回 'no-capacity' 则本轮停止（机器已满，等下次释放再试），保证 FIFO 不被跳过。
 */
export function startQueueReconciler(dispatch: (task: QueuedTask) => Promise<DispatchResult>): () => void {
  if (timer) {
    return () => {};
  }
  const tick = async () => {
    try {
      await reconcileQueueOnce(dispatch);
    } catch (err) {
      console.error('[taskQueue] reconcile failed:', err instanceof Error ? err.message : err);
    }
  };
  timer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
