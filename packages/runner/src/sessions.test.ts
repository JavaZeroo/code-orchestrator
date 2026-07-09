import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerSession } from './sessions';
import { addSession, getSession, listSessionStates, removeSession } from './sessions';

const added: string[] = [];

function fakeSession(sessionId: string, state: RunnerSession['state'] = 'idle'): RunnerSession {
  return {
    sessionId,
    state,
    start: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(async () => true),
    kill: vi.fn(),
    decideApproval: vi.fn(() => true),
  };
}

describe('session registry', () => {
  afterEach(() => {
    for (const id of added.splice(0)) {
      removeSession(id);
    }
  });

  it('stores, lists, and removes session state through the registry API', () => {
    const first = fakeSession('s-reg-1', 'idle');
    const second = fakeSession('s-reg-2', 'thinking');

    addSession(first);
    addSession(second);
    added.push(first.sessionId, second.sessionId);

    expect(getSession('s-reg-1')).toBe(first);
    expect(listSessionStates()).toEqual(
      expect.arrayContaining([
        { sessionId: 's-reg-1', state: 'idle' },
        { sessionId: 's-reg-2', state: 'thinking' },
      ]),
    );

    removeSession('s-reg-1');

    expect(getSession('s-reg-1')).toBeUndefined();
    expect(listSessionStates()).not.toContainEqual({ sessionId: 's-reg-1', state: 'idle' });
  });

  it('lets a later session replace an existing registry entry for the same id', () => {
    const initial = fakeSession('s-reg-replace', 'idle');
    const replacement = fakeSession('s-reg-replace', 'waiting_input');

    addSession(initial);
    addSession(replacement);
    added.push(initial.sessionId);

    expect(getSession('s-reg-replace')).toBe(replacement);
    expect(listSessionStates()).toContainEqual({ sessionId: 's-reg-replace', state: 'waiting_input' });
  });
});
