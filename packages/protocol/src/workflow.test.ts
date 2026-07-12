import { describe, expect, it } from 'vitest';
import { runNoteMarkdownSchema, runNotePayloadSchema, runNoteRevisionPayloadSchema, workflowDefSchema } from './workflow';

const base = {
  name: 't',
  nodes: [
    { id: 'a', type: 'agent', prompt: 'do' },
    { id: 'gate', type: 'gate' },
  ],
  edges: [['a', 'gate']],
};

describe('workflowDefSchema', () => {
  it('接受合法 agent→gate 图', () => {
    const r = workflowDefSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('拒绝重复节点 id', () => {
    const r = workflowDefSchema.safeParse({ ...base, nodes: [...base.nodes, { id: 'a', type: 'gate' }] });
    expect(r.success).toBe(false);
  });

  it('拒绝指向未知节点的边', () => {
    const r = workflowDefSchema.safeParse({ ...base, edges: [['a', 'nope']] });
    expect(r.success).toBe(false);
  });

  it('agent 节点带 effort/permissionMode/reviseLoop 合法', () => {
    const r = workflowDefSchema.safeParse({
      name: 't',
      nodes: [
        { id: 'impl', type: 'agent', prompt: 'p', model: 'deepseek', permissionMode: 'bypassPermissions' },
        { id: 'rev', type: 'agent', prompt: 'r', effort: 'high', reviseLoop: { target: 'impl' } },
      ],
      edges: [['impl', 'rev']],
    });
    expect(r.success).toBe(true);
  });
});

describe('run note schema', () => {
  it('normalizes Markdown notes and rejects blank content', () => {
    expect(runNoteMarkdownSchema.parse('  **Hold** until approval.  ')).toBe('**Hold** until approval.');
    expect(runNoteMarkdownSchema.safeParse(' \n\t ').success).toBe(false);
    expect(runNotePayloadSchema.parse({
      markdown: 'Deployment approved.',
      author: 'operator@example.com',
    })).toEqual({ markdown: 'Deployment approved.', author: 'operator@example.com' });
  });

  it('validates an append-only run note revision target and Markdown', () => {
    expect(runNoteRevisionPayloadSchema.parse({ noteId: 9, markdown: '  Proceed.  ' }))
      .toEqual({ noteId: 9, markdown: 'Proceed.' });
    expect(runNoteRevisionPayloadSchema.safeParse({ noteId: -1, markdown: 'Proceed.' }).success).toBe(false);
  });
});
