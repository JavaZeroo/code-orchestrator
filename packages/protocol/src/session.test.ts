import { describe, expect, it } from 'vitest';
import {
  agentBackendDescriptorSchema,
  sessionNoteDeletionPayloadSchema,
  sessionNoteMarkdownSchema,
  sessionNotePayloadSchema,
  sessionNoteRevisionPayloadSchema,
  supportsAgentBackendCapability,
} from './session';

describe('AgentBackend capability contract', () => {
  it('lets callers negotiate features without branching on backend names', () => {
    const descriptor = agentBackendDescriptorSchema.parse({
      name: 'claude',
      capabilities: {
        hostSession: true,
        containerSession: true,
        resume: true,
        fork: true,
        interrupt: true,
        designerTools: true,
        taskIntakeTools: true,
      },
    });

    expect(supportsAgentBackendCapability(descriptor, 'designerTools')).toBe(true);
    expect(supportsAgentBackendCapability(descriptor, 'resume')).toBe(true);
    expect(descriptor.constraints).toEqual([]);
  });

  it('publishes combination constraints with a user-visible rejection reason', () => {
    const descriptor = agentBackendDescriptorSchema.parse({
      name: 'claude',
      capabilities: {
        hostSession: true, containerSession: true, resume: true, fork: true,
        interrupt: true, designerTools: true, taskIntakeTools: true,
      },
      constraints: [{
        allOf: ['containerSession', 'designerTools'],
        reason: 'designer tools require a host session',
      }],
    });

    expect(descriptor.constraints[0]?.reason).toContain('host session');
  });
});

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
