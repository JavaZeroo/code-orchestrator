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
