import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerMethodHandler } from './methods';
import { addSession, removeSession, type RunnerSession } from './sessions';

describe('session.send idempotency', () => {
  afterEach(() => removeSession('send-session'));

  it('delivers the same persisted Harness feedback key at most once', async () => {
    const send = vi.fn();
    const session: RunnerSession = {
      sessionId: 'send-session',
      state: 'idle',
      start: vi.fn(),
      send,
      interrupt: vi.fn(async () => true),
      kill: vi.fn(),
      decideApproval: vi.fn(() => true),
    };
    addSession(session);
    const handle = createRunnerMethodHandler({ conn: null });
    const params = {
      sessionId: 'send-session',
      text: 'Evaluator failed; continue.',
      idempotencyKey: 'run-1:node-1:attempt-1:feedback',
    };

    await expect(handle('session.send', params)).resolves.toEqual({ ok: true });
    await expect(handle('session.send', params)).resolves.toEqual({ ok: true });

    expect(send).toHaveBeenCalledTimes(1);
  });
});
