import { describe, expect, it, vi } from 'vitest';
import {
  clearRetriedNodeOutputs,
  retryWorkflowRunWithDependencies,
  type WorkflowRunRetryDependencies,
  type WorkflowRunRetryRecord,
  type WorkflowRunRetryTransition,
  workflowRunRetryBlockReason,
} from './workflowRunRetry';

const failedRun: WorkflowRunRetryRecord = {
  id: 'run-1',
  status: 'failed',
  context: {
    vars: { release: '1.0' },
    outputs: { prepare: 'ready', deploy: 'stale failure' },
  },
  endedAt: new Date('2026-07-11T06:00:00Z'),
  archivedAt: null,
};

const transition: WorkflowRunRetryTransition = {
  run: {
    ...failedRun,
    status: 'running',
    context: {
      vars: { release: '1.0' },
      outputs: { prepare: 'ready' },
    },
    endedAt: null,
  },
  retriedNodeIds: ['deploy'],
  eventSeq: 42,
  eventPayload: { by: 'operator@example.com', retriedNodeIds: ['deploy'] },
};

function dependencies(overrides: Partial<WorkflowRunRetryDependencies> = {}): WorkflowRunRetryDependencies {
  return {
    load: vi.fn(async () => failedRun),
    transition: vi.fn(async () => transition),
    notify: vi.fn(),
    schedule: vi.fn(),
    ...overrides,
  };
}

describe('workflow run retry eligibility', () => {
  it('allows only unarchived failed runs', () => {
    expect(workflowRunRetryBlockReason(failedRun)).toBeNull();
    expect(workflowRunRetryBlockReason({ ...failedRun, archivedAt: new Date() })).toContain('restored');
    for (const status of ['running', 'waiting_human', 'done', 'cancelled']) {
      expect(workflowRunRetryBlockReason({ ...failedRun, status })).toContain('not failed');
    }
  });

  it('removes only retried node outputs without mutating retained upstream state', () => {
    const context = {
      vars: { release: '1.0' },
      outputs: { prepare: 'ready', deploy: 'stale failure', verify: 'also stale' },
      reviseRounds: { review: 2 },
    };

    expect(clearRetriedNodeOutputs(context, ['deploy', 'verify'])).toEqual({
      vars: { release: '1.0' },
      outputs: { prepare: 'ready' },
      reviseRounds: { review: 2 },
    });
    expect(context.outputs).toEqual({ prepare: 'ready', deploy: 'stale failure', verify: 'also stale' });
  });
});

describe('workflow run retry transition', () => {
  it('publishes and schedules the atomic failed-node transition', async () => {
    const deps = dependencies();

    await expect(retryWorkflowRunWithDependencies('run-1', 'operator@example.com', deps)).resolves.toEqual(transition);
    expect(deps.transition).toHaveBeenCalledWith('run-1', 'operator@example.com');
    expect(deps.notify).toHaveBeenCalledWith('run-1', transition.eventSeq, transition.eventPayload);
    expect(deps.schedule).toHaveBeenCalledWith('run-1', ['deploy']);
  });

  it('rejects archived and non-failed runs before attempting a transition', async () => {
    const archived = dependencies({ load: vi.fn(async () => ({ ...failedRun, archivedAt: new Date() })) });
    const running = dependencies({ load: vi.fn(async () => ({ ...failedRun, status: 'running' })) });

    await expect(retryWorkflowRunWithDependencies('run-1', 'ui', archived)).rejects.toMatchObject({ statusCode: 409 });
    await expect(retryWorkflowRunWithDependencies('run-1', 'ui', running)).rejects.toMatchObject({ statusCode: 409 });
    expect(archived.transition).not.toHaveBeenCalled();
    expect(running.transition).not.toHaveBeenCalled();
  });

  it('lets only one concurrent request win the atomic transition', async () => {
    const deps = dependencies({
      transition: vi.fn()
        .mockResolvedValueOnce(transition)
        .mockResolvedValueOnce(null),
    });

    const results = await Promise.allSettled([
      retryWorkflowRunWithDependencies('run-1', 'ui', deps),
      retryWorkflowRunWithDependencies('run-1', 'ui', deps),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409 }) }),
    ]);
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(deps.schedule).toHaveBeenCalledOnce();
  });

  it('returns 404 for an unknown run', async () => {
    const deps = dependencies({ load: vi.fn(async () => null) });

    await expect(retryWorkflowRunWithDependencies('missing', 'ui', deps)).rejects.toMatchObject({
      statusCode: 404,
      message: 'run not found: missing',
    });
    expect(deps.transition).not.toHaveBeenCalled();
  });
});
