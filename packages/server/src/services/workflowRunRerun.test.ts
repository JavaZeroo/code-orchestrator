import { describe, expect, it, vi } from 'vitest';
import {
  rerunWorkflowRunWithDependencies,
  reusableWorkflowRunVars,
  type WorkflowRunRerunDependencies,
  type WorkflowRunRerunRecord,
  workflowRunRerunBlockReason,
} from './workflowRunRerun';

const sourceRun: WorkflowRunRerunRecord = {
  id: 'run-source',
  defId: 'workflow-release',
  projectId: 'project-platform',
  status: 'done',
  context: {
    vars: { release: '2.4.0', environment: 'staging' },
    outputs: { deploy: 'completed output must not be reused' },
    reviseRounds: { review: 2 },
  },
};

function dependencies(overrides: Partial<WorkflowRunRerunDependencies> = {}): WorkflowRunRerunDependencies {
  return {
    load: vi.fn(async () => sourceRun),
    start: vi.fn(async () => 'run-new'),
    ...overrides,
  };
}

describe('workflow run rerun eligibility', () => {
  it('allows completed, failed, and cancelled runs but rejects every active state', () => {
    for (const status of ['done', 'failed', 'cancelled']) {
      expect(workflowRunRerunBlockReason({ ...sourceRun, status })).toBeNull();
    }
    for (const status of ['running', 'waiting_human', 'paused']) {
      expect(workflowRunRerunBlockReason({ ...sourceRun, status })).toContain('still active');
    }
  });

  it('copies only the original string input variables', () => {
    const vars = reusableWorkflowRunVars(sourceRun.context);

    expect(vars).toEqual({ release: '2.4.0', environment: 'staging' });
    expect(vars).not.toBe(sourceRun.context.vars);
    expect(vars).not.toHaveProperty('outputs');
  });
});

describe('workflow run rerun start', () => {
  it('starts a distinct run with the source definition, project, and variables', async () => {
    const deps = dependencies();

    await expect(rerunWorkflowRunWithDependencies('run-source', deps)).resolves.toEqual({ runId: 'run-new' });
    expect(deps.start).toHaveBeenCalledWith(
      'workflow-release',
      { release: '2.4.0', environment: 'staging' },
      'project-platform',
    );
  });

  it('preserves an explicitly unscoped source instead of inheriting definition scope', async () => {
    const deps = dependencies({ load: vi.fn(async () => ({ ...sourceRun, projectId: null })) });

    await rerunWorkflowRunWithDependencies('run-source', deps);

    expect(deps.start).toHaveBeenCalledWith(
      'workflow-release',
      { release: '2.4.0', environment: 'staging' },
      null,
    );
  });

  it('rejects active and missing sources without starting another run', async () => {
    const active = dependencies({ load: vi.fn(async () => ({ ...sourceRun, status: 'running' })) });
    const missing = dependencies({ load: vi.fn(async () => null) });

    await expect(rerunWorkflowRunWithDependencies('run-source', active)).rejects.toMatchObject({ statusCode: 409 });
    await expect(rerunWorkflowRunWithDependencies('missing', missing)).rejects.toMatchObject({
      statusCode: 404,
      message: 'run not found: missing',
    });
    expect(active.start).not.toHaveBeenCalled();
    expect(missing.start).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted variables instead of changing their meaning', async () => {
    const deps = dependencies({
      load: vi.fn(async () => ({ ...sourceRun, context: { vars: { release: 24 } } })),
    });

    await expect(rerunWorkflowRunWithDependencies('run-source', deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(deps.start).not.toHaveBeenCalled();
  });
});
