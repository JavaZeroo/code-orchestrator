/**
 * 任务排队（design-v2 Q9）：需加速器的任务在无空闲机时进 pending；
 * 机器释放后 reconciler 按 FIFO+priority 自动派发——兑现「你只管提任务，有资源就自动跑」。
 * dispatch 由 #31（spawn 集成）注入：真正去 schedule+物化+起容器+起 agent。
 */

import { asc, desc, eq } from 'drizzle-orm';
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

async function listPending(): Promise<QueuedTask[]> {
  if (!hasDb()) {
    return [];
  }
  const rows = await getDb()
    .select()
    .from(schema.taskQueue)
    .where(eq(schema.taskQueue.status, 'pending'))
    .orderBy(desc(schema.taskQueue.priority), asc(schema.taskQueue.enqueuedAt));
  return rows.map((r) => ({ id: r.id, projectId: r.projectId, kind: r.kind, payload: r.payload, priority: r.priority }));
}

async function setStatus(id: string, status: 'pending' | 'scheduled' | 'running' | 'done' | 'failed'): Promise<void> {
  if (hasDb()) {
    await getDb().update(schema.taskQueue).set({ status }).where(eq(schema.taskQueue.id, id));
  }
}

export const markTaskRunning = (id: string) => setStatus(id, 'running');
export const markTaskDone = (id: string) => setStatus(id, 'done');
export const markTaskFailed = (id: string) => setStatus(id, 'failed');

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
      const pending = await listPending();
      for (const task of pending) {
        const res = await dispatch(task);
        if (res === 'no-capacity') {
          break; // 机器满，保持其余 pending，下轮再试
        }
        await setStatus(task.id, res === 'started' ? 'running' : 'failed');
      }
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
