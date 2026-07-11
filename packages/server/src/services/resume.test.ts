import { describe, expect, it, vi } from 'vitest';
import {
  type ResumeDependencies,
  type ResumeSessionRecord,
  resumeBlockReason,
  resumeSessionWithDependencies,
} from './resume';

const eligible: ResumeSessionRecord = {
  id: 'session-1',
  machineId: 'runner-1',
  agent: 'claude',
  model: 'claude-sonnet',
  cwd: '/tmp/work',
  state: 'dead',
  nativeSessionId: 'native-1',
  runId: null,
  containerId: null,
  archivedAt: null,
  createdBy: 'user-1',
};

function dependencies(overrides: Partial<ResumeDependencies> = {}): ResumeDependencies {
  return {
    load: vi.fn(async () => eligible),
    claim: vi.fn(async () => eligible),
    rollback: vi.fn(async () => {}),
    runnerOnline: vi.fn(() => true),
    resolveModel: vi.fn(async () => ({ model: 'claude-sonnet', env: { PROVIDER_KEY: 'in-memory-test' } })),
    resumeRunner: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('resumeBlockReason', () => {
  it('allows only dead host-run manual Claude/Codex sessions with native context on an online runner', () => {
    expect(resumeBlockReason(eligible, true)).toBeNull();
    expect(resumeBlockReason({ ...eligible, agent: 'codex' }, true)).toBeNull();
    expect(resumeBlockReason({ ...eligible, state: 'idle' }, true)).toBe('session is not dead');
    expect(resumeBlockReason({ ...eligible, runId: 'run-1' }, true)).toContain('workflow');
    expect(resumeBlockReason({ ...eligible, containerId: 'container-1' }, true)).toContain('container');
    expect(resumeBlockReason({ ...eligible, archivedAt: new Date() }, true)).toContain('restored');
    expect(resumeBlockReason({ ...eligible, nativeSessionId: null }, true)).toContain('native session ID');
    expect(resumeBlockReason(eligible, false)).toContain('offline');
  });
});

describe('resumeSessionWithDependencies', () => {
  it('passes the existing orchestrator and native IDs to the original runner', async () => {
    const deps = dependencies();

    await expect(resumeSessionWithDependencies('session-1', deps)).resolves.toEqual({ sessionId: 'session-1' });
    expect(deps.resumeRunner).toHaveBeenCalledWith(
      'runner-1',
      expect.objectContaining({
        sessionId: 'session-1',
        nativeSessionId: 'native-1',
        agent: 'claude',
        cwd: '/tmp/work',
      }),
    );
  });

  it('returns 409 when another request wins the atomic claim', async () => {
    const deps = dependencies({ claim: vi.fn(async () => null) });

    await expect(resumeSessionWithDependencies('session-1', deps)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deps.resumeRunner).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('rolls the session back to dead when the runner rejects resume', async () => {
    const deps = dependencies({
      resumeRunner: vi.fn(async () => ({ ok: false, error: 'native context unavailable' })),
    });

    await expect(resumeSessionWithDependencies('session-1', deps)).rejects.toMatchObject({
      statusCode: 502,
      message: 'native context unavailable',
    });
    expect(deps.rollback).toHaveBeenCalledWith('session-1');
  });
});
