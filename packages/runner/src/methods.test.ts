import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerMethodHandler } from './methods';
import { addSession, removeSession, type RunnerSession } from './sessions';

function handler() {
  return createRunnerMethodHandler({ conn: null });
}

const addedSessions: string[] = [];

function fakeSession(sessionId: string, state: RunnerSession['state'] = 'idle'): RunnerSession {
  return {
    sessionId,
    state,
    start: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(async () => true),
    kill: vi.fn(),
    decideApproval: vi.fn((approvalId: string) => approvalId === 'approval-ok'),
  };
}

describe('createRunnerMethodHandler', () => {
  afterEach(() => {
    for (const id of addedSessions.splice(0)) {
      removeSession(id);
    }
  });

  it('executes machine.exec and returns stdout plus exit code', async () => {
    const result = await handler()('machine.exec', {
      cmd: 'node -e "process.stdout.write(\'runner-ok\')"',
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'runner-ok', stderr: '' });
  });

  it('maps non-zero machine.exec failures without throwing', async () => {
    const result = await handler()('machine.exec', {
      cmd: 'node -e "process.stderr.write(\'bad\'); process.exit(7)"',
    });

    expect(result).toEqual({ exitCode: 7, stdout: '', stderr: 'bad' });
  });

  it('rejects unsupported opencode session spawn without creating a session', async () => {
    const result = await handler()('session.spawn', {
      sessionId: 's-opencode',
      agent: 'opencode',
      cwd: '/tmp',
    });

    expect(result).toEqual({ ok: false, error: 'agent "opencode" not supported yet' });
  });

  it('rejects designer/taskIntake tools for agents that do not support them yet', async () => {
    await expect(
      handler()('session.spawn', {
        sessionId: 's-codex-designer',
        agent: 'codex',
        cwd: '/tmp',
        designer: true,
      }),
    ).resolves.toEqual({ ok: false, error: 'agent "codex" does not support designer/taskIntake MCP tools yet' });

    await expect(
      handler()('session.spawn', {
        sessionId: 's-codex-intake',
        agent: 'codex',
        cwd: '/tmp',
        taskIntake: true,
      }),
    ).resolves.toEqual({ ok: false, error: 'agent "codex" does not support designer/taskIntake MCP tools yet' });
  });

  it('routes send, interrupt, kill, and approval decisions to a running session', async () => {
    const session = fakeSession('s-running', 'idle');
    addSession(session);
    addedSessions.push(session.sessionId);

    await expect(handler()('session.send', { sessionId: 's-running', text: 'continue' })).resolves.toEqual({ ok: true });
    expect(session.send).toHaveBeenCalledWith('continue', undefined);

    await expect(handler()('session.interrupt', { sessionId: 's-running' })).resolves.toEqual({ ok: true });
    expect(session.interrupt).toHaveBeenCalledOnce();

    await expect(
      handler()('approval.decide', {
        sessionId: 's-running',
        approvalId: 'approval-ok',
        decision: { behavior: 'allow' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(session.decideApproval).toHaveBeenCalledWith('approval-ok', { behavior: 'allow' });

    await expect(
      handler()('approval.decide', {
        sessionId: 's-running',
        approvalId: 'approval-missing',
        decision: { behavior: 'deny', message: 'no' },
      }),
    ).resolves.toEqual({ ok: false, error: 'approval not pending: approval-missing' });

    await expect(handler()('session.kill', { sessionId: 's-running' })).resolves.toEqual({ ok: true });
    expect(session.kill).toHaveBeenCalledOnce();
    await expect(handler()('session.send', { sessionId: 's-running', text: 'after kill' })).resolves.toEqual({
      ok: false,
      error: 'session not running: s-running',
    });
  });

  it('does not send or interrupt sessions that are already dead', async () => {
    const session = fakeSession('s-dead', 'dead');
    addSession(session);
    addedSessions.push(session.sessionId);

    await expect(handler()('session.send', { sessionId: 's-dead', text: 'hello' })).resolves.toEqual({
      ok: false,
      error: 'session not running: s-dead',
    });
    await expect(handler()('session.interrupt', { sessionId: 's-dead' })).resolves.toEqual({
      ok: false,
      error: 'session not running: s-dead',
    });
    expect(session.send).not.toHaveBeenCalled();
    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it('reports missing sessions for send, interrupt, and approval decisions', async () => {
    await expect(handler()('session.send', { sessionId: 'missing', text: 'hello' })).resolves.toEqual({
      ok: false,
      error: 'session not running: missing',
    });
    await expect(handler()('session.interrupt', { sessionId: 'missing' })).resolves.toEqual({
      ok: false,
      error: 'session not running: missing',
    });
    await expect(
      handler()('approval.decide', {
        sessionId: 'missing',
        approvalId: 'a1',
        decision: { behavior: 'allow' },
      }),
    ).resolves.toEqual({ ok: false, error: 'session not found: missing' });
  });

  it('throws for unknown methods and invalid params', async () => {
    await expect(handler()('nope', {})).rejects.toThrow('unknown method: nope');
    await expect(handler()('machine.exec', { timeoutMs: 10 })).rejects.toThrow();
  });
});
