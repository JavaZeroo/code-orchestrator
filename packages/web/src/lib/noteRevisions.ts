import type { EventRow } from '../api';

export function latestNoteRevisions(events: EventRow[], type: 'session.note.updated' | 'run.note.updated'): Map<number, string> {
  const revisions = new Map<number, string>();
  for (const event of events) {
    if (event.type !== type) continue;
    const payload = event.payload as { noteId?: unknown; markdown?: unknown };
    if (typeof payload.noteId === 'number' && typeof payload.markdown === 'string') {
      revisions.set(payload.noteId, payload.markdown);
    }
  }
  return revisions;
}

export function deletedNoteIds(events: EventRow[], type: 'session.note.deleted' | 'run.note.deleted'): Set<number> {
  const deleted = new Set<number>();
  for (const event of events) {
    if (event.type !== type) continue;
    const noteId = (event.payload as { noteId?: unknown }).noteId;
    if (typeof noteId === 'number') deleted.add(noteId);
  }
  return deleted;
}
