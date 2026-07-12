import { describe, expect, it, vi } from 'vitest';
import {
  appendSessionNoteWithDependencies,
  deleteSessionNoteWithDependencies,
  reviseSessionNoteWithDependencies,
  SessionNoteError,
  type SessionNoteDependencies,
} from './sessionNote';

function dependencies(sessionExists = true): SessionNoteDependencies {
  return {
    sessionExists: vi.fn().mockResolvedValue(sessionExists),
    noteExists: vi.fn().mockResolvedValue(sessionExists),
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

  it('appends a scoped revision event for an existing note', async () => {
    const deps = dependencies();
    await expect(reviseSessionNoteWithDependencies('session-1', {
      noteId: 12, markdown: 'Corrected context.',
    }, deps)).resolves.toEqual({
      seq: 42,
      type: 'session.note.updated',
      sessionId: 'session-1',
      payload: { noteId: 12, markdown: 'Corrected context.' },
    });
    expect(deps.noteExists).toHaveBeenCalledWith('session-1', 12);
    expect(deps.publishEvent).toHaveBeenCalledWith({
      type: 'session.note.updated', sessionId: 'session-1', payload: { noteId: 12, markdown: 'Corrected context.' },
    });
  });

  it('rejects an unknown or mismatched note without publishing a revision', async () => {
    const deps = dependencies(false);
    await expect(reviseSessionNoteWithDependencies('session-1', {
      noteId: 99, markdown: 'Do not save.',
    }, deps)).rejects.toEqual(new SessionNoteError(404, 'session note not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });

  it('appends a scoped deletion tombstone for an existing note', async () => {
    const deps = dependencies();
    await expect(deleteSessionNoteWithDependencies('session-1', { noteId: 12 }, deps)).resolves.toEqual({
      seq: 42, type: 'session.note.deleted', sessionId: 'session-1', payload: { noteId: 12 },
    });
    expect(deps.noteExists).toHaveBeenCalledWith('session-1', 12);
    expect(deps.publishEvent).toHaveBeenCalledWith({
      type: 'session.note.deleted', sessionId: 'session-1', payload: { noteId: 12 },
    });
  });

  it('rejects deletion of an unknown or cross-session note', async () => {
    const deps = dependencies(false);
    await expect(deleteSessionNoteWithDependencies('session-1', { noteId: 99 }, deps))
      .rejects.toEqual(new SessionNoteError(404, 'session note not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});
