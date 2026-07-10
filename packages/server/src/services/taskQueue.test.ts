import { describe, expect, it, vi } from 'vitest';
import {
  cancelQueuedTask,
  listQueuedTasks,
  reconcileQueueOnce,
  type QueuedTask,
  type TaskQueueStatus,
  type TaskQueueStore,
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
      .map(({ status: _status, ...task }) => ({ ...task }));
    const afterList = this.afterList;
    this.afterList = undefined;
    await afterList?.();
    return result;
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
