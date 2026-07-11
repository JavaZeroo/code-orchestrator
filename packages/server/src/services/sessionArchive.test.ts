import { describe, expect, it, vi } from 'vitest';
import {
  archiveBlockReason,
  archiveSessionWithDependencies,
  restoreBlockReason,
  restoreSessionWithDependencies,
  type SessionArchiveDependencies,
  type SessionArchiveRecord,
} from './sessionArchive';

const eligible: SessionArchiveRecord = {
  id: 'session-1',
  state: 'dead',
  runId: null,
  archivedAt: null,
};

function dependencies(overrides: Partial<SessionArchiveDependencies> = {}): SessionArchiveDependencies {
  const archived = { ...eligible, archivedAt: new Date('2026-07-11T04:00:00Z') };
  return {
    load: vi.fn(async () => eligible),
    archive: vi.fn(async () => archived),
    restore: vi.fn(async () => eligible),
    ...overrides,
  };
}

describe('session archive eligibility', () => {
  it('allows only unarchived dead manual sessions to be archived', () => {
    expect(archiveBlockReason(eligible)).toBeNull();
    expect(archiveBlockReason({ ...eligible, state: 'idle' })).toContain('still active');
    expect(archiveBlockReason({ ...eligible, runId: 'run-1' })).toContain('workflow');
    expect(archiveBlockReason({ ...eligible, archivedAt: new Date() })).toContain('already archived');
  });

  it('allows only archived sessions to be restored', () => {
    expect(restoreBlockReason({ ...eligible, archivedAt: new Date() })).toBeNull();
    expect(restoreBlockReason(eligible)).toContain('not archived');
  });
});

describe('session archive transitions', () => {
  it('persists the archive timestamp returned by the atomic transition', async () => {
    const deps = dependencies();

    await expect(archiveSessionWithDependencies('session-1', deps)).resolves.toMatchObject({
      id: 'session-1',
      archivedAt: new Date('2026-07-11T04:00:00Z'),
    });
    expect(deps.archive).toHaveBeenCalledWith('session-1');
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it('clears the archive timestamp when restoring', async () => {
    const archived = { ...eligible, archivedAt: new Date('2026-07-11T04:00:00Z') };
    const deps = dependencies({ load: vi.fn(async () => archived) });

    await expect(restoreSessionWithDependencies('session-1', deps)).resolves.toEqual(eligible);
    expect(deps.restore).toHaveBeenCalledWith('session-1');
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it('rejects ineligible sessions before attempting a transition', async () => {
    const deps = dependencies({ load: vi.fn(async () => ({ ...eligible, state: 'thinking' })) });

    await expect(archiveSessionWithDependencies('session-1', deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('still active'),
    });
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it('returns 409 when another request wins the atomic transition', async () => {
    const deps = dependencies({ archive: vi.fn(async () => null) });

    await expect(archiveSessionWithDependencies('session-1', deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no longer eligible'),
    });
  });

  it('returns 404 for an unknown session', async () => {
    const deps = dependencies({ load: vi.fn(async () => null) });

    await expect(restoreSessionWithDependencies('missing', deps)).rejects.toMatchObject({
      statusCode: 404,
      message: 'session not found: missing',
    });
  });
});
