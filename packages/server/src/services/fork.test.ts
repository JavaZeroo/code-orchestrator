import { describe, expect, it, vi } from 'vitest';
import {
  type ForkDependencies,
  type ForkSessionRecord,
  forkBlockReason,
  forkSessionWithDependencies,
  forkedSessionTitle,
} from './fork';

const eligible: ForkSessionRecord = {
  id: 'source-session',
  machineId: 'runner-1',
  agent: 'claude',
  model: 'claude-sonnet',
  role: 'developer',
  cwd: '/tmp/source-work',
  title: 'Original conversation',
  state: 'idle',
  nativeSessionId: 'native-source',
  runId: null,
  projectId: 'project-1',
  containerId: null,
  archivedAt: null,
  createdBy: 'user-1',
};

function dependencies(overrides: Partial<ForkDependencies> = {}): ForkDependencies {
  return {
    load: vi.fn(async () => eligible),
    runnerOnline: vi.fn(() => true),
    resolveModel: vi.fn(async () => ({ model: 'claude-sonnet', env: { PROVIDER_KEY: 'in-memory-test' } })),
    prepare: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    forkRunner: vi.fn(async () => ({ ok: true, nativeSessionId: 'native-fork' })),
    killRunner: vi.fn(async () => {}),
    createSessionId: vi.fn(() => 'fork-session'),
    ...overrides,
  };
}

describe('forkBlockReason', () => {
  it('allows idle or dead manual host Claude/Codex sessions with saved native context', () => {
    expect(forkBlockReason(eligible, true)).toBeNull();
    expect(forkBlockReason({ ...eligible, state: 'dead' }, true)).toBeNull();
    expect(forkBlockReason({ ...eligible, agent: 'codex' }, true)).toBeNull();
  });

  it('rejects busy, workflow, container, missing-context, unsupported, and offline sessions', () => {
    expect(forkBlockReason({ ...eligible, state: 'thinking' }, true)).toContain('busy');
    expect(forkBlockReason({ ...eligible, runId: 'run-1' }, true)).toContain('workflow');
    expect(forkBlockReason({ ...eligible, containerId: 'container-1' }, true)).toContain('container');
    expect(forkBlockReason({ ...eligible, archivedAt: new Date() }, true)).toContain('restored');
    expect(forkBlockReason({ ...eligible, nativeSessionId: null }, true)).toContain('native session ID');
    expect(forkBlockReason({ ...eligible, agent: 'opencode' }, true)).toContain('cannot be forked');
    expect(forkBlockReason(eligible, false)).toContain('offline');
  });
});

describe('forkedSessionTitle', () => {
  it('marks and bounds the independent conversation title', () => {
    expect(forkedSessionTitle(eligible)).toBe('Original conversation (fork)');
    expect(forkedSessionTitle({ title: null, cwd: '/tmp/source-work' })).toBe('source-work (fork)');
    expect(forkedSessionTitle({ title: 'x'.repeat(200), cwd: '/tmp/work' })).toHaveLength(120);
  });
});

describe('forkSessionWithDependencies', () => {
  it('persists a copied transcript and starts a target with a distinct native ID', async () => {
    const deps = dependencies();

    await expect(forkSessionWithDependencies('source-session', 'requester-1', deps)).resolves.toEqual({
      sessionId: 'fork-session',
    });

    expect(deps.prepare).toHaveBeenCalledWith(
      eligible,
      expect.objectContaining({
        id: 'fork-session',
        machineId: 'runner-1',
        agent: 'claude',
        cwd: '/tmp/source-work',
        title: 'Original conversation (fork)',
        projectId: 'project-1',
        createdBy: 'requester-1',
      }),
    );
    expect(deps.forkRunner).toHaveBeenCalledWith(
      'runner-1',
      expect.objectContaining({
        sourceSessionId: 'source-session',
        sessionId: 'fork-session',
        nativeSessionId: 'native-source',
      }),
    );
    expect(deps.finalize).toHaveBeenCalledWith('fork-session', 'native-fork');
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(deps.killRunner).not.toHaveBeenCalled();
  });

  it('rejects an ineligible source before creating any target state', async () => {
    const deps = dependencies({ load: vi.fn(async () => ({ ...eligible, state: 'waiting_approval' })) });

    await expect(forkSessionWithDependencies('source-session', undefined, deps)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('busy'),
    });
    expect(deps.resolveModel).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.forkRunner).not.toHaveBeenCalled();
  });

  it('removes prepared target state when the runner rejects the native fork', async () => {
    const deps = dependencies({
      forkRunner: vi.fn(async () => ({ ok: false, error: 'native context unavailable' })),
    });

    await expect(forkSessionWithDependencies('source-session', undefined, deps)).rejects.toMatchObject({
      statusCode: 502,
      message: 'native context unavailable',
    });
    expect(deps.rollback).toHaveBeenCalledWith('fork-session');
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('kills and removes a target when the runner does not return a distinct native ID', async () => {
    const deps = dependencies({
      forkRunner: vi.fn(async () => ({ ok: true, nativeSessionId: 'native-source' })),
    });

    await expect(forkSessionWithDependencies('source-session', undefined, deps)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('distinct native session ID'),
    });
    expect(deps.killRunner).toHaveBeenCalledWith('runner-1', 'fork-session');
    expect(deps.rollback).toHaveBeenCalledWith('fork-session');
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('kills the target and rolls persistence back if finalization fails', async () => {
    const deps = dependencies({ finalize: vi.fn(async () => { throw new Error('database write failed'); }) });

    await expect(forkSessionWithDependencies('source-session', undefined, deps)).rejects.toMatchObject({
      statusCode: 502,
      message: 'fork failed: database write failed',
    });
    expect(deps.killRunner).toHaveBeenCalledWith('runner-1', 'fork-session');
    expect(deps.rollback).toHaveBeenCalledWith('fork-session');
  });
});
