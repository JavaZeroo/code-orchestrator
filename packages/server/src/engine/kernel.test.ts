import { describe, expect, it } from 'vitest';
import { workflowDefSchema } from '@co/protocol';
import {
  evaluateConditionExpression,
  fanoutSettlement,
  nextFanoutIndexes,
  resolveContextValue,
  resolveFanoutItems,
  skippedBranchNodeIds,
  substituteTemplate,
} from './kernel';

const context = {
  vars: { enabled: 'true', threshold: '2', fallback: '["a"]' },
  outputs: {
    split: JSON.stringify({ items: [{ id: 1, title: 'first' }, { id: 2, title: 'second' }] }),
    review: JSON.stringify({ score: 8, verdict: 'approve' }),
  },
};

describe('agent execution kernel context', () => {
  it('resolves structured outputs and local fanout item values', () => {
    expect(resolveContextValue('split.items.1.title', context)).toBe('second');
    expect(substituteTemplate('work on {{item.title}} #{{index}}', context, {
      item: { title: 'first' },
      index: 0,
    })).toBe('work on first #0');
    expect(resolveContextValue('analysis.items.0', {
      vars: {},
      outputs: { analysis: '拆分结果如下：\n```json\n{"items":["task-a"]}\n```' },
    })).toBe('task-a');
  });

  it('evaluates restricted boolean expressions without eval', () => {
    expect(evaluateConditionExpression('vars.enabled && outputs.review.score >= 8', context)).toBe(true);
    expect(evaluateConditionExpression('outputs.review.verdict == "reject" || vars.threshold > 3', context)).toBe(false);
    expect(evaluateConditionExpression('vars.threshold == 2', context)).toBe(true);
    expect(() => evaluateConditionExpression('outputs.missing.value', context)).toThrow(/unknown value/);
  });

  it('resolves fanout arrays and enforces the expansion bound', () => {
    expect(resolveFanoutItems('split.items', context, 2)).toHaveLength(2);
    expect(() => resolveFanoutItems('split.items', context, 1)).toThrow(/exceeding maxItems/);
    expect(() => resolveFanoutItems('review.score', context, 10)).toThrow(/must resolve to an array/);
  });
});

describe('fanout concurrency planning', () => {
  it('counts queued work as active and fills only available slots', () => {
    expect(nextFanoutIndexes([
      { index: 0, status: 'running' },
      { index: 1, status: 'queued' },
      { index: 2, status: 'pending' },
      { index: 3, status: 'pending' },
    ], 3)).toEqual([2]);
  });

  it('settles only after every child is terminal', () => {
    expect(fanoutSettlement([{ status: 'done' }, { status: 'pending' }])).toBe('running');
    expect(fanoutSettlement([{ status: 'done' }, { status: 'done' }])).toBe('done');
    expect(fanoutSettlement([{ status: 'done' }, { status: 'failed' }])).toBe('failed');
  });
});

describe('condition branch planning', () => {
  const def = workflowDefSchema.parse({
    name: 'branch',
    nodes: [
      { id: 'condition', type: 'condition', expr: 'vars.enabled', onTrue: ['yes'], onFalse: ['no'] },
      { id: 'yes', type: 'agent', prompt: 'yes' },
      { id: 'no', type: 'agent', prompt: 'no' },
      { id: 'join', type: 'agent', prompt: 'join' },
    ],
    edges: [['condition', 'yes'], ['condition', 'no'], ['yes', 'join'], ['no', 'join']],
  });

  it('skips only the rejected branch and preserves the shared join', () => {
    expect(skippedBranchNodeIds(def, ['yes'], ['no'])).toEqual(['no']);
    expect(skippedBranchNodeIds(def, ['no'], ['yes'])).toEqual(['yes']);
  });
});
