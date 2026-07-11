import type { ApprovalDecision, MessageMeta, SessionState } from '@co/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerMethodHandler } from './methods';
import { getSession, removeSession } from './sessions';

const startMock = vi.hoisted(() => vi.fn());

vi.mock('./claude/driver', () => ({
  forkClaudeNativeSession: vi.fn(async () => 'claude-native-fork'),
  ClaudeSession: class {
    readonly sessionId: string;
    readonly nativeSessionId: string | undefined;
    state: SessionState = 'starting';

    constructor(
      params: { sessionId: string },
      _emit: unknown,
      resumeNativeSessionId?: string,
    ) {
      this.sessionId = params.sessionId;
      this.nativeSessionId = resumeNativeSessionId;
    }

    start = startMock;
    send(_text: string, _meta?: MessageMeta) {}
    async interrupt() { return true; }
    kill() { this.state = 'dead'; }
    decideApproval(_approvalId: string, _decision: ApprovalDecision) { return false; }
  },
}));

describe('createRunnerMethodHandler session.resume', () => {
  afterEach(() => {
    removeSession('resume-session');
    vi.clearAllMocks();
  });

  it('recreates a host session with its native ID and rejects a concurrent resume', async () => {
    const run = createRunnerMethodHandler({ conn: null });
    const params = {
      sessionId: 'resume-session',
      agent: 'claude',
      cwd: '/tmp/work',
      nativeSessionId: 'claude-native-1',
    } as const;

    await expect(run('session.resume', params)).resolves.toEqual({ ok: true });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(getSession('resume-session')).toMatchObject({
      sessionId: 'resume-session',
      nativeSessionId: 'claude-native-1',
      state: 'starting',
    });
    await expect(run('session.resume', params)).resolves.toEqual({
      ok: false,
      error: 'session already running: resume-session',
    });
  });
});
