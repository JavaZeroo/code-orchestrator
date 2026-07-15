import { describe, expect, it } from 'vitest';
import { runNoteDeletionPayloadSchema, runNoteMarkdownSchema, runNotePayloadSchema, runNoteRevisionPayloadSchema, workflowDefSchema } from './workflow';

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

  it('agent 节点接受 evidence-backed TaskContract，旧节点保持兼容', () => {
    const r = workflowDefSchema.safeParse({
      name: 'capability-loop',
      nodes: [{
        id: 'implement',
        type: 'agent',
        prompt: 'implement the change',
        contract: {
          acceptanceCriteria: [{
            id: 'tests',
            description: 'unit tests pass',
            evaluator: { kind: 'command', run: 'pnpm test' },
          }],
          budget: { maxAttempts: 2 },
        },
      }],
    });

    expect(r.success).toBe(true);
    if (r.success) {
      const node = r.data.nodes[0];
      expect(node?.type === 'agent' ? node.contract?.budget.maxAttempts : undefined).toBe(2);
    }
    expect(workflowDefSchema.safeParse(base).success).toBe(true);
  });

  it('接受带显式真假后继的 condition 和有界 fanout', () => {
    const r = workflowDefSchema.safeParse({
      name: 'branch-and-fanout',
      nodes: [
        { id: 'choose', type: 'condition', expr: 'outputs.plan.enabled', onTrue: ['split'], onFalse: ['stop'] },
        {
          id: 'split', type: 'fanout', itemsFrom: 'plan.items', maxItems: 8, maxConcurrency: 2, failFast: true,
          template: { prompt: 'work {{item}}' },
        },
        { id: 'stop', type: 'gate' },
      ],
      edges: [['choose', 'split'], ['choose', 'stop']],
    });
    expect(r.success).toBe(true);
  });

  it('为 fanout 提供安全的并发和失败策略默认值', () => {
    const parsed = workflowDefSchema.parse({
      name: 'fanout-defaults',
      nodes: [{ id: 'split', type: 'fanout', itemsFrom: 'vars.items', template: { prompt: 'work {{item}}' } }],
      edges: [],
    });
    expect(parsed.nodes[0]).toMatchObject({ maxItems: 32, maxConcurrency: 4, failFast: false });
    expect(workflowDefSchema.safeParse({
      name: 'fanout-unbounded',
      nodes: [{ id: 'split', type: 'fanout', itemsFrom: 'vars.items', maxConcurrency: 33, template: { prompt: 'work' } }],
      edges: [],
    }).success).toBe(false);
  });

  it('拒绝 condition 未标注的后继和有环图', () => {
    const unlabeled = workflowDefSchema.safeParse({
      name: 'bad-branch',
      nodes: [
        { id: 'choose', type: 'condition', expr: 'true', onTrue: ['yes'] },
        { id: 'yes', type: 'gate' },
        { id: 'no', type: 'gate' },
      ],
      edges: [['choose', 'yes'], ['choose', 'no']],
    });
    expect(unlabeled.success).toBe(false);

    const cyclic = workflowDefSchema.safeParse({
      name: 'cycle',
      nodes: [{ id: 'a', type: 'gate' }, { id: 'b', type: 'gate' }],
      edges: [['a', 'b'], ['b', 'a']],
    });
    expect(cyclic.success).toBe(false);
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

  it('validates a run note deletion tombstone target', () => {
    expect(runNoteDeletionPayloadSchema.parse({ noteId: 9 })).toEqual({ noteId: 9 });
    expect(runNoteDeletionPayloadSchema.safeParse({ noteId: -1 }).success).toBe(false);
  });
});
