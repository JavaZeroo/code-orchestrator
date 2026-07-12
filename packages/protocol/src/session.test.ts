import { describe, expect, it } from 'vitest';
import { sessionNoteMarkdownSchema, sessionNotePayloadSchema } from './session';

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
});
