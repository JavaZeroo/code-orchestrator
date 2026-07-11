import { describe, expect, it, vi } from 'vitest';
import {
  startRecordedIntakeWithDependencies,
  type RecordedIntakeContext,
  type RecordedIntakeStartDependencies,
} from './intake';

const context: RecordedIntakeContext = {
  intake: {
    id: 'intake-1',
    triggerId: 'trigger-1',
    projectId: 'project-1',
    forge: 'github',
    repo: 'acme/widgets',
    issueNumber: '42',
    title: 'Stored title',
    author: 'stored-author',
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    runId: null,
    status: 'seeded',
  },
  trigger: {
    id: 'trigger-1',
    defId: 'workflow-1',
    forge: 'github',
    repo: 'acme/widgets',
    vars: { priority: 'trigger', base: 'develop' },
  },
  project: {
    id: 'project-1',
    name: 'Widgets',
    vars: { priority: 'project', team: 'platform' },
  },
};

function dependencies(overrides: Partial<RecordedIntakeStartDependencies> = {}): RecordedIntakeStartDependencies {
  return {
    load: vi.fn(async () => context),
    claim: vi.fn(async () => true),
    getIssue: vi.fn(async () => ({
      number: '42',
      title: 'Live issue title',
      body: 'Full issue body',
      state: 'open',
      labels: ['enhancement'],
      author: 'issue-author',
      htmlUrl: 'https://github.com/acme/widgets/issues/42',
    })),
    launch: vi.fn(async () => 'run-1'),
    rollback: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('startRecordedIntakeWithDependencies', () => {
  it('starts a seeded intake with its project, trigger, and refreshed issue variables', async () => {
    const deps = dependencies();

    await expect(startRecordedIntakeWithDependencies('intake-1', deps)).resolves.toEqual({ runId: 'run-1' });
    expect(deps.claim).toHaveBeenCalledWith('intake-1');
    expect(deps.launch).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ number: '42', body: 'Full issue body' }),
      {
        priority: 'trigger',
        team: 'platform',
        base: 'develop',
        forge: 'github',
        repo: 'acme/widgets',
        issue_number: '42',
        issue_title: 'Live issue title',
        issue_body: 'Full issue body',
        issue_url: 'https://github.com/acme/widgets/issues/42',
        issue_author: 'issue-author',
      },
    );
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('rejects an already-started intake without claiming or launching it again', async () => {
    const deps = dependencies({
      load: vi.fn(async () => ({ ...context, intake: { ...context.intake, status: 'started' as const, runId: 'run-existing' } })),
    });

    await expect(startRecordedIntakeWithDependencies('intake-1', deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('returns a conflict when another request wins the intake claim', async () => {
    const deps = dependencies({ claim: vi.fn(async () => false) });

    await expect(startRecordedIntakeWithDependencies('intake-1', deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(deps.getIssue).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('rolls a failed intake back to a retriable state when relaunch fails', async () => {
    const failedContext = { ...context, intake: { ...context.intake, status: 'failed' as const } };
    const launchError = new Error('runner unavailable');
    const deps = dependencies({
      load: vi.fn(async () => failedContext),
      launch: vi.fn(async () => {
        throw launchError;
      }),
    });

    await expect(startRecordedIntakeWithDependencies('intake-1', deps)).rejects.toMatchObject({
      statusCode: 502,
      message: 'requirement intake launch failed: runner unavailable',
    });
    expect(deps.claim).toHaveBeenCalledWith('intake-1');
    expect(deps.rollback).toHaveBeenCalledWith(failedContext, launchError);
  });
});
