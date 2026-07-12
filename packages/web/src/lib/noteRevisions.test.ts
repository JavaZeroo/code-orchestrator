import { describe, expect, it } from 'vitest';
import { deletedNoteIds, latestNoteRevisions } from './noteRevisions';

describe('note revision folding', () => {
  it('selects the latest revision for each note without moving the creation event', () => {
    const revisions = latestNoteRevisions([
      { seq: 10, type: 'session.note', payload: { markdown: 'Original', author: 'operator' } },
      { seq: 12, type: 'session.note.updated', payload: { noteId: 10, markdown: 'First edit' } },
      { seq: 14, type: 'session.note.updated', payload: { noteId: 10, markdown: 'Latest edit' } },
      { seq: 15, type: 'run.note.updated', payload: { noteId: 10, markdown: 'Wrong scope' } },
    ], 'session.note.updated');

    expect(revisions).toEqual(new Map([[10, 'Latest edit']]));
  });
});

describe('note deletion folding', () => {
  it('collects only valid deletion tombstones for the requested scope', () => {
    expect(deletedNoteIds([
      { seq: 1, type: 'session.note.deleted', payload: { noteId: 7 } },
      { seq: 2, type: 'run.note.deleted', payload: { noteId: 8 } },
      { seq: 3, type: 'session.note.deleted', payload: { noteId: 'bad' } },
    ], 'session.note.deleted')).toEqual(new Set([7]));
  });
});
