import { describe, expect, it } from 'vitest';
import { projectCapabilityMetrics } from './capabilityMetrics';

describe('capability metrics projection', () => {
  it('projects outcomes, attempts, evaluator pass rate, context packs, and failure classes from events', () => {
    const metrics = projectCapabilityMetrics([
      { type: 'run.capability.attempt', payload: { attempt: 1, status: 'running' } },
      { type: 'run.capability.evaluation', payload: { status: 'passed' } },
      { type: 'run.capability.outcome', payload: { status: 'achieved', attempts: [{ number: 1 }], evidence: [{ kind: 'usage', costUsd: 1.5 }] } },
      { type: 'run.capability.attempt', payload: { attempt: 1, status: 'running' } },
      { type: 'run.capability.evaluation', payload: { status: 'failed' } },
      { type: 'run.capability.context_pack', payload: { version: 1 } },
      { type: 'run.capability.attempt', payload: { attempt: 2, status: 'running' } },
      { type: 'run.capability.evaluation', payload: { status: 'failed' } },
      { type: 'run.capability.outcome', payload: { status: 'exhausted', failureType: 'budget_exhausted', attempts: [{ number: 1 }, { number: 2 }] } },
    ]);

    expect(metrics).toEqual({
      outcomes: 2,
      achieved: 1,
      solveRate: 0.5,
      firstPassRate: 0.5,
      averageAttempts: 1.5,
      evaluations: { total: 3, passed: 1, failed: 2, error: 0, passRate: 1 / 3 },
      contextPacks: 1,
      totalCostUsd: 1.5,
      failuresByType: { budget_exhausted: 1 },
    });
  });
});
