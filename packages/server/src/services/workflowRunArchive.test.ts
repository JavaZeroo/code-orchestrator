import { describe, expect, it, vi } from 'vitest';
import {
  archiveWorkflowRunWithDependencies,
  restoreWorkflowRunWithDependencies,
  type WorkflowRunArchiveDependencies,
  type WorkflowRunArchiveRecord,
  workflowRunArchiveBlockReason,
  workflowRunRestoreBlockReason,
} from './workflowRunArchive';

const eligible: WorkflowRunArchiveRecord = {
  id: 'run-1',
  status: 'done',
  archivedAt: null,
};

function dependencies(overrides: Partial<WorkflowRunArchiveDependencies> = {}): WorkflowRunArchiveDependencies {
  const archived = { ...eligible, archivedAt: new Date('2026-07-11T05:00:00Z') };
  return {
    load: vi.fn(async () => eligible),
    archive: vi.fn(async () => archived),
    restore: vi.fn(async () => eligible),
    ...overrides,
  };
}

describe('workflow run archive eligibility', () => {
  it.each(['done', 'failed', 'cancelled'])('allows an unarchived %s run', (status) => {
    expect(workflowRunArchiveBlockReason({ ...eligible, status })).toBeNull();
  });

  it.each(['running', 'waiting_human'])('rejects an active %s run', (status) => {
    expect(workflowRunArchiveBlockReason({ ...eligible, status })).toContain('still active');
  });

  it('rejects duplicate archive and restore transitions', () => {
    const archived = { ...eligible, archivedAt: new Date('2026-07-11T05:00:00Z') };
    expect(workflowRunArchiveBlockReason(archived)).toContain('already archived');
    expect(workflowRunRestoreBlockReason(eligible)).toContain('not archived');
    expect(workflowRunRestoreBlockReason(archived)).toBeNull();
  });
});

describe('workflow run archive transitions', () => {
  it('persists the timestamp returned by the atomic archive transition', async () => {
    const deps = dependencies();

    await expect(archiveWorkflowRunWithDependencies('run-1', deps)).resolves.toMatchObject({
      id: 'run-1',
      archivedAt: new Date('2026-07-11T05:00:00Z'),
    });
    expect(deps.archive).toHaveBeenCalledWith('run-1');
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it('clears the archive timestamp when restoring', async () => {
    const archived = { ...eligible, archivedAt: new Date('2026-07-11T05:00:00Z') };
    const deps = dependencies({ load: vi.fn(async () => archived) });

    await expect(restoreWorkflowRunWithDependencies('run-1', deps)).resolves.toEqual(eligible);
    expect(deps.restore).toHaveBeenCalledWith('run-1');
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it('returns 409 without writing when the run is active', async () => {
    const deps = dependencies({ load: vi.fn(async () => ({ ...eligible, status: 'running' })) });

    await expect(archiveWorkflowRunWithDependencies('run-1', deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('still active'),
    });
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it('returns 409 when another request wins the atomic archive transition', async () => {
    const deps = dependencies({ archive: vi.fn(async () => null) });

    await expect(archiveWorkflowRunWithDependencies('run-1', deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no longer eligible'),
    });
  });

  it('returns 409 when another request wins the atomic restore transition', async () => {
    const archived = { ...eligible, archivedAt: new Date('2026-07-11T05:00:00Z') };
    const deps = dependencies({
      load: vi.fn(async () => archived),
      restore: vi.fn(async () => null),
    });

    await expect(restoreWorkflowRunWithDependencies('run-1', deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no longer eligible'),
    });
  });

  it('returns 404 for an unknown run', async () => {
    const deps = dependencies({ load: vi.fn(async () => null) });

    await expect(archiveWorkflowRunWithDependencies('missing', deps)).rejects.toMatchObject({
      statusCode: 404,
      message: 'run not found: missing',
    });
  });
});
