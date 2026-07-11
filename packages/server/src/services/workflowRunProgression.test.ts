import { describe, expect, it, vi } from 'vitest';
import { serializeRunProgression } from '../engine/engine';
import {
  pauseWorkflowRunWithDependencies,
  resumeWorkflowRunWithDependencies,
  type WorkflowRunProgressionDependencies,
  type WorkflowRunProgressionRecord,
  type WorkflowRunProgressionTransition,
  workflowRunPauseBlockReason,
  workflowRunResumeBlockReason,
} from './workflowRunProgression';

const runningRun: WorkflowRunProgressionRecord = { id: 'run-1', status: 'running' };
const pausedRun: WorkflowRunProgressionRecord = { id: 'run-1', status: 'paused' };

const pausedTransition: WorkflowRunProgressionTransition = {
  run: pausedRun,
  eventSeq: 41,
  eventPayload: { status: 'paused', by: 'operator@example.com' },
};

const resumedTransition: WorkflowRunProgressionTransition = {
  run: runningRun,
  eventSeq: 42,
  eventPayload: { status: 'running', by: 'operator@example.com' },
};

function immediateSerialization<T>(_runId: string, operation: () => Promise<T>): Promise<T> {
  return operation();
}

function dependencies(
  run: WorkflowRunProgressionRecord,
  transition: WorkflowRunProgressionTransition,
  overrides: Partial<WorkflowRunProgressionDependencies> = {},
): WorkflowRunProgressionDependencies {
  return {
    load: vi.fn(async () => run),
    transition: vi.fn(async () => transition),
    notify: vi.fn(),
    serialize: immediateSerialization,
    schedule: vi.fn(),
    ...overrides,
  };
}

describe('workflow run progression eligibility', () => {
  it('pauses only active runs and resumes only paused runs', () => {
    expect(workflowRunPauseBlockReason(runningRun)).toBeNull();
    expect(workflowRunPauseBlockReason({ ...runningRun, status: 'waiting_human' })).toBeNull();
    for (const status of ['paused', 'done', 'failed', 'cancelled']) {
      expect(workflowRunPauseBlockReason({ ...runningRun, status })).toContain('cannot be paused');
    }

    expect(workflowRunResumeBlockReason(pausedRun)).toBeNull();
    for (const status of ['running', 'waiting_human', 'done', 'failed', 'cancelled']) {
      expect(workflowRunResumeBlockReason({ ...pausedRun, status })).toContain('not paused');
    }
  });
});

describe('workflow run progression transitions', () => {
  it('records pause without scheduling new work', async () => {
    const deps = dependencies(runningRun, pausedTransition);

    await expect(pauseWorkflowRunWithDependencies('run-1', 'operator@example.com', deps)).resolves.toEqual(pausedTransition);

    expect(deps.transition).toHaveBeenCalledWith('run-1', 'pause', 'operator@example.com');
    expect(deps.notify).toHaveBeenCalledWith('run-1', pausedTransition.eventSeq, pausedTransition.eventPayload);
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it('schedules one progression tick after a successful resume', async () => {
    const deps = dependencies(pausedRun, resumedTransition);

    await expect(resumeWorkflowRunWithDependencies('run-1', 'operator@example.com', deps)).resolves.toEqual(resumedTransition);

    expect(deps.transition).toHaveBeenCalledWith('run-1', 'resume', 'operator@example.com');
    expect(deps.notify).toHaveBeenCalledWith('run-1', resumedTransition.eventSeq, resumedTransition.eventPayload);
    expect(deps.schedule).toHaveBeenCalledOnce();
    expect(deps.schedule).toHaveBeenCalledWith('run-1');
  });

  it('lets only one concurrent resume claim and schedule the paused run', async () => {
    const deps = dependencies(pausedRun, resumedTransition, {
      transition: vi.fn()
        .mockResolvedValueOnce(resumedTransition)
        .mockResolvedValueOnce(null),
    });

    const results = await Promise.allSettled([
      resumeWorkflowRunWithDependencies('run-1', 'ui', deps),
      resumeWorkflowRunWithDependencies('run-1', 'ui', deps),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409 }) }),
    ]);
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(deps.schedule).toHaveBeenCalledOnce();
  });

  it('rejects invalid and lost transitions with 409 and unknown runs with 404', async () => {
    const invalid = dependencies(pausedRun, pausedTransition);
    const lost = dependencies(runningRun, pausedTransition, { transition: vi.fn(async () => null) });
    const missing = dependencies(runningRun, pausedTransition, { load: vi.fn(async () => null) });

    await expect(pauseWorkflowRunWithDependencies('run-1', 'ui', invalid)).rejects.toMatchObject({ statusCode: 409 });
    await expect(pauseWorkflowRunWithDependencies('run-1', 'ui', lost)).rejects.toMatchObject({ statusCode: 409 });
    await expect(resumeWorkflowRunWithDependencies('missing', 'ui', missing)).rejects.toMatchObject({
      statusCode: 404,
      message: 'run not found: missing',
    });
    expect(invalid.transition).not.toHaveBeenCalled();
    expect(missing.transition).not.toHaveBeenCalled();
  });

  it('serializes run controls behind already queued progression work', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = serializeRunProgression('run-serialization-test', async () => {
      await firstGate;
      order.push('tick');
    });
    const control = serializeRunProgression('run-serialization-test', async () => {
      order.push('pause');
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, control]);
    expect(order).toEqual(['tick', 'pause']);
  });
});
