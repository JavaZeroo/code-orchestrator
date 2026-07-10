import { describe, expect, it, vi } from 'vitest';
import {
  cancelQueuedTask,
  listQueuedTasks,
  reconcileQueueOnce,
  reprioritizeQueuedTask,
  retryFailedQueuedTask,
  type QueuedTask,
  type TaskQueueStatus,
  type TaskQueueStore,
  type VisibleQueuedTask,
} from './taskQueue';

interface MemoryRow extends QueuedTask {
  status: TaskQueueStatus;
}

class MemoryQueueStore implements TaskQueueStore {
  readonly rows = new Map<string, MemoryRow>();
  afterList?: () => Promise<void>;

  constructor(rows: MemoryRow[]) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  async listPending(projectId?: string): Promise<QueuedTask[]> {
    const result = [...this.rows.values()]
      .filter((row) => row.status === 'pending' && (!projectId || row.projectId === projectId))
      .sort((a, b) => b.priority - a.priority || a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
      .map(({ status: _status, ...task }) => ({ ...task }));
    const afterList = this.afterList;
    this.afterList = undefined;
    await afterList?.();
    return result;
  }

  async listVisible(projectId: string): Promise<VisibleQueuedTask[]> {
    return [...this.rows.values()]
      .filter((row) => (row.status === 'pending' || row.status === 'failed') && row.projectId === projectId)
      .sort((a, b) => b.priority - a.priority || a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
      .map((task) => ({ ...task, status: task.status as VisibleQueuedTask['status'] }));
  }

  async transition(
    id: string,
    from: TaskQueueStatus,
    to: TaskQueueStatus,
    projectId?: string,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== from || (projectId && row.projectId !== projectId)) return false;
    row.status = to;
    return true;
  }

  async updatePriority(id: string, priority: number, projectId?: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending' || (projectId && row.projectId !== projectId)) return false;
    row.priority = priority;
    return true;
  }

  async requeueFailed(id: string, projectId: string, enqueuedAt: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'failed' || row.projectId !== projectId) return false;
    row.status = 'pending';
    row.enqueuedAt = enqueuedAt;
    return true;
  }

  async find(id: string, projectId?: string): Promise<{ status: TaskQueueStatus } | null> {
    const row = this.rows.get(id);
    return row && (!projectId || row.projectId === projectId) ? { status: row.status } : null;
  }
}

function pending(id = 'task-1'): MemoryRow {
  return {
    id,
    projectId: 'project-1',
    kind: 'ascend-npu',
    payload: { prompt: 'train model' },
    priority: 0,
    status: 'pending',
    enqueuedAt: new Date('2026-07-11T00:00:00Z'),
  };
}

describe('queued task priority', () => {
  it('moves a reprioritized pending task ahead while equal priorities stay FIFO', async () => {
    const older = pending('older');
    const newer = pending('newer');
    newer.enqueuedAt = new Date('2026-07-11T00:01:00Z');
    const store = new MemoryQueueStore([older, newer]);

    await expect(reprioritizeQueuedTask('project-1', 'newer', 10, store)).resolves.toEqual({
      outcome: 'updated',
      priority: 10,
    });
    await expect(listQueuedTasks('project-1', store)).resolves.toMatchObject([
      { id: 'newer', priority: 10 },
      { id: 'older', priority: 0 },
    ]);

    await expect(reprioritizeQueuedTask('project-1', 'older', 10, store)).resolves.toEqual({
      outcome: 'updated',
      priority: 10,
    });
    await expect(listQueuedTasks('project-1', store)).resolves.toMatchObject([
      { id: 'older', priority: 10 },
      { id: 'newer', priority: 10 },
    ]);
  });

  it('returns not found for an unknown task and a conflict for a terminal task', async () => {
    const completed = pending('completed');
    completed.status = 'done';
    const store = new MemoryQueueStore([completed]);

    await expect(reprioritizeQueuedTask('project-1', 'missing', 5, store)).resolves.toEqual({
      outcome: 'not-found',
    });
    await expect(reprioritizeQueuedTask('project-1', 'completed', 5, store)).resolves.toEqual({
      outcome: 'conflict',
      status: 'done',
    });
    expect(store.rows.get('completed')?.priority).toBe(0);
  });

  it('returns a conflict when the reconciler claim wins the reprioritization race', async () => {
    const store = new MemoryQueueStore([pending()]);
    let reprioritization: Awaited<ReturnType<typeof reprioritizeQueuedTask>> | undefined;

    await reconcileQueueOnce(async () => {
      reprioritization = await reprioritizeQueuedTask('project-1', 'task-1', 50, store);
      return 'started';
    }, store, Date.parse('2026-07-11T01:00:00Z'));

    expect(reprioritization).toEqual({ outcome: 'conflict', status: 'scheduled' });
    expect(store.rows.get('task-1')).toMatchObject({ priority: 0, status: 'running' });
  });
});

describe('queued task cancellation', () => {
  it('atomically cancels a pending task and removes it from the project pending list', async () => {
    const store = new MemoryQueueStore([pending()]);

    await expect(cancelQueuedTask('project-1', 'task-1', store)).resolves.toEqual({ outcome: 'cancelled' });
    await expect(listQueuedTasks('project-1', store)).resolves.toEqual([]);
    expect(store.rows.get('task-1')?.status).toBe('cancelled');
  });

  it('rejects cancellation once a task is no longer pending', async () => {
    const row = pending();
    row.status = 'running';
    const store = new MemoryQueueStore([row]);

    await expect(cancelQueuedTask('project-1', 'task-1', store)).resolves.toEqual({
      outcome: 'conflict',
      status: 'running',
    });
  });

  it('does not dispatch when cancellation wins after the reconciler reads a stale pending list', async () => {
    const store = new MemoryQueueStore([pending()]);
    store.afterList = async () => {
      await cancelQueuedTask('project-1', 'task-1', store);
    };
    const dispatch = vi.fn().mockResolvedValue('started');

    await reconcileQueueOnce(dispatch, store, Date.parse('2026-07-11T01:00:00Z'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.rows.get('task-1')?.status).toBe('cancelled');
  });

  it('returns a conflict when the reconciler claim wins the cancellation race', async () => {
    const store = new MemoryQueueStore([pending()]);
    let cancellation: Awaited<ReturnType<typeof cancelQueuedTask>> | undefined;

    await reconcileQueueOnce(async () => {
      cancellation = await cancelQueuedTask('project-1', 'task-1', store);
      return 'started';
    }, store, Date.parse('2026-07-11T01:00:00Z'));

    expect(cancellation).toEqual({ outcome: 'conflict', status: 'scheduled' });
    expect(store.rows.get('task-1')?.status).toBe('running');
  });
});

describe('failed queued task retry', () => {
  it('requeues a failed task with a fresh enqueue time while preserving payload and priority', async () => {
    const row = pending();
    const payload = { prompt: 'resume training', env: { RUN_ID: 'run-1' } };
    row.status = 'failed';
    row.payload = payload;
    row.priority = 17;
    const store = new MemoryQueueStore([row]);
    const retriedAt = new Date('2026-07-11T02:00:00Z');

    await expect(retryFailedQueuedTask('project-1', row.id, store, retriedAt)).resolves.toEqual({
      outcome: 'retried',
    });

    expect(store.rows.get(row.id)).toMatchObject({
      status: 'pending',
      priority: 17,
      enqueuedAt: retriedAt,
    });
    expect(store.rows.get(row.id)?.payload).toBe(payload);
    await expect(listQueuedTasks('project-1', store)).resolves.toMatchObject([
      { id: row.id, status: 'pending', payload, priority: 17, enqueuedAt: retriedAt },
    ]);
  });

  it('isolates projects and rejects unknown or non-failed tasks', async () => {
    const otherProject = pending('other-project-task');
    otherProject.projectId = 'project-2';
    otherProject.status = 'failed';
    const pendingTask = pending('pending-task');
    const store = new MemoryQueueStore([otherProject, pendingTask]);

    await expect(retryFailedQueuedTask('project-1', 'missing', store)).resolves.toEqual({
      outcome: 'not-found',
    });
    await expect(retryFailedQueuedTask('project-1', otherProject.id, store)).resolves.toEqual({
      outcome: 'not-found',
    });
    await expect(retryFailedQueuedTask('project-1', pendingTask.id, store)).resolves.toEqual({
      outcome: 'conflict',
      status: 'pending',
    });
    expect(otherProject.status).toBe('failed');
    await expect(listQueuedTasks('project-1', store)).resolves.toMatchObject([
      { id: pendingTask.id, status: 'pending' },
    ]);
  });
});
