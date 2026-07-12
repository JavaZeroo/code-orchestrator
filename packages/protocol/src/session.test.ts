import { describe, expect, it } from 'vitest';
import { sessionNoteDeletionPayloadSchema, sessionNoteMarkdownSchema, sessionNotePayloadSchema, sessionNoteRevisionPayloadSchema } from './session';

describe('session note schema', () => {
  it('normalizes Markdown notes and rejects blank content', () => {
    expect(sessionNotePayloadSchema.parse({
      markdown: '  **Handoff** to the next operator.  ',
      author: ' operator@example.com ',
    })).toEqual({
      markdown: '**Handoff** to the next operator.',
      author: 'operator@example.com',
    });
    expect(() => sessionNoteMarkdownSchema.parse(' \n\t ')).toThrow();
  });

  it('validates an append-only note revision target and Markdown', () => {
    expect(sessionNoteRevisionPayloadSchema.parse({ noteId: 12, markdown: '  Corrected.  ' }))
      .toEqual({ noteId: 12, markdown: 'Corrected.' });
    expect(sessionNoteRevisionPayloadSchema.safeParse({ noteId: 0, markdown: 'Corrected.' }).success).toBe(false);
  });

  it('validates a note deletion tombstone target', () => {
    expect(sessionNoteDeletionPayloadSchema.parse({ noteId: 12 })).toEqual({ noteId: 12 });
    expect(sessionNoteDeletionPayloadSchema.safeParse({ noteId: 0 }).success).toBe(false);
  });
});
