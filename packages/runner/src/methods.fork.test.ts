import type { ApprovalDecision, MessageMeta, SessionState } from '@co/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerMethodHandler } from './methods';
import { addSession, getSession, removeSession, type RunnerSession } from './sessions';

const forkClaudeNativeSessionMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());

vi.mock('./claude/driver', () => ({
  forkClaudeNativeSession: forkClaudeNativeSessionMock,
  ClaudeSession: class {
    readonly sessionId: string;
    readonly nativeSessionId: string | undefined;
    state: SessionState = 'starting';

    constructor(params: { sessionId: string }, _emit: unknown, nativeSessionId?: string) {
      this.sessionId = params.sessionId;
      this.nativeSessionId = nativeSessionId;
    }

    start = startMock;
    send(_text: string, _meta?: MessageMeta) {}
    async interrupt() { return true; }
    kill() { this.state = 'dead'; }
    decideApproval(_approvalId: string, _decision: ApprovalDecision) { return false; }
  },
}));

function sourceSession(state: SessionState): RunnerSession {
  return {
    sessionId: 'source-session',
    state,
    start() {},
    send() {},
    async interrupt() { return true; },
    kill() {},
    decideApproval() { return false; },
  };
}

describe('createRunnerMethodHandler session.fork', () => {
  afterEach(() => {
    removeSession('source-session');
    removeSession('fork-session');
    vi.clearAllMocks();
  });

  it('forks Claude native history before starting the independent target session', async () => {
    forkClaudeNativeSessionMock.mockResolvedValue('claude-native-fork');
    addSession(sourceSession('idle'));
    const run = createRunnerMethodHandler({ conn: null });

    await expect(
      run('session.fork', {
        sourceSessionId: 'source-session',
        sessionId: 'fork-session',
        agent: 'claude',
        cwd: '/tmp/work',
        nativeSessionId: 'claude-native-source',
      }),
    ).resolves.toEqual({ ok: true, nativeSessionId: 'claude-native-fork' });

    expect(forkClaudeNativeSessionMock).toHaveBeenCalledWith('claude-native-source', '/tmp/work');
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(getSession('source-session')?.state).toBe('idle');
    expect(getSession('fork-session')).toMatchObject({
      sessionId: 'fork-session',
      nativeSessionId: 'claude-native-fork',
    });
  });

  it('rejects a busy source without creating native or runner state', async () => {
    addSession(sourceSession('thinking'));
    const run = createRunnerMethodHandler({ conn: null });

    await expect(
      run('session.fork', {
        sourceSessionId: 'source-session',
        sessionId: 'fork-session',
        agent: 'claude',
        cwd: '/tmp/work',
        nativeSessionId: 'claude-native-source',
      }),
    ).resolves.toEqual({ ok: false, error: 'source session is busy: source-session' });

    expect(forkClaudeNativeSessionMock).not.toHaveBeenCalled();
    expect(getSession('fork-session')).toBeUndefined();
  });
});
