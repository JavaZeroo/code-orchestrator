import { describe, expect, it, vi } from 'vitest';
import {
  appendSessionNoteWithDependencies,
  SessionNoteError,
  type SessionNoteDependencies,
} from './sessionNote';

function dependencies(sessionExists = true): SessionNoteDependencies {
  return {
    sessionExists: vi.fn().mockResolvedValue(sessionExists),
    publishEvent: vi.fn().mockResolvedValue(42),
  };
}

describe('standalone session notes', () => {
  it('publishes exactly one session-scoped append-only event', async () => {
    const deps = dependencies();
    const payload = { markdown: '**Handoff** context.', author: 'operator@example.com' };
    await expect(appendSessionNoteWithDependencies('session-1', payload, deps)).resolves.toEqual({
      seq: 42,
      type: 'session.note',
      sessionId: 'session-1',
      payload,
    });
    expect(deps.publishEvent).toHaveBeenCalledOnce();
    expect(deps.publishEvent).toHaveBeenCalledWith({ type: 'session.note', sessionId: 'session-1', payload });
  });

  it('rejects an unknown session without publishing', async () => {
    const deps = dependencies(false);
    await expect(appendSessionNoteWithDependencies('missing', {
      markdown: 'Do not save.', author: 'operator@example.com',
    }, deps)).rejects.toEqual(new SessionNoteError(404, 'session not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});
