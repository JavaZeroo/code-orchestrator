import { describe, expect, it } from 'vitest';
import { agentOutcomeSchema } from '@co/protocol';
import {
  agentCapabilityCaseSchema,
  assessAgentCapabilityObservation,
  summarizeAgentCapabilityBenchmark,
  summarizeAgentCapabilityBenchmarkByVersion,
} from './agentCapability';

function commandEvidence(pass: boolean) {
  return {
    kind: 'command' as const,
    criterionId: 'tests',
    command: 'pnpm test',
    pass,
    exitCode: pass ? 0 : 1,
    stdout: pass ? 'passed' : '',
    stderr: pass ? '' : 'failed',
    durationMs: 100,
  };
}

describe('Agent capability benchmark', () => {
  it('keeps a task, frozen repository fixture, success contract, and expectations together', () => {
    const benchmarkCase = agentCapabilityCaseSchema.parse({
      id: 'protocol-contract',
      title: 'Add an evidence-backed task contract',
      category: 'feature',
      repository: { path: '.', baseRef: '95cbe39adfc886dbc7c7393907f9196e81612965' },
      prompt: 'Add the TaskContract protocol schema without breaking old workflow definitions.',
      contract: {
        acceptanceCriteria: [{
          id: 'protocol-tests',
          description: 'protocol tests pass',
          evaluator: { kind: 'command', run: 'pnpm --filter @co/protocol test:unit' },
        }],
      },
      expectations: { status: 'achieved', maxAttempts: 3, maxHumanInterventions: 0 },
    });

    expect(benchmarkCase.version).toBe(1);
    expect(benchmarkCase.contract.budget.maxAttempts).toBe(3);
  });

  it('gates a harness observation against the case expectations', () => {
    const benchmarkCase = agentCapabilityCaseSchema.parse({
      id: 'recovery', title: 'Recover a task', category: 'recovery',
      repository: { path: '.', baseRef: 'main' }, prompt: 'recover it',
      contract: {
        acceptanceCriteria: [{ id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      },
      expectations: { status: 'achieved', maxAttempts: 1, maxHumanInterventions: 0 },
    });
    const observation = {
      caseId: 'recovery', harnessVersion: 'v1', backend: 'claude' as const,
      startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:01:00.000Z',
      humanInterventions: 0,
      outcome: agentOutcomeSchema.parse({
        status: 'achieved', summary: 'done', evidence: [commandEvidence(true)],
        attempts: [{
          number: 1, sessionId: 's1', startedAt: '2026-07-15T00:00:00.000Z',
          endedAt: '2026-07-15T00:01:00.000Z', status: 'passed',
          evaluations: [{ criterionId: 'tests', status: 'passed', detail: 'ok', evidence: commandEvidence(true) }],
        }],
      }),
    };

    expect(assessAgentCapabilityObservation(benchmarkCase, observation)).toEqual({ pass: true, reasons: [] });
  });

  it('reports solve rate, first-pass rate, attempts, interventions, duration, and cost', () => {
    const achieved = agentOutcomeSchema.parse({
      status: 'achieved',
      summary: 'done',
      evidence: [commandEvidence(true), { kind: 'usage', costUsd: 1.25, turns: 2 }],
      attempts: [{
        number: 1,
        sessionId: 's1',
        startedAt: '2026-07-15T00:00:00.000Z',
        endedAt: '2026-07-15T00:01:00.000Z',
        status: 'passed',
        evaluations: [{ criterionId: 'tests', status: 'passed', detail: 'ok', evidence: commandEvidence(true) }],
      }],
    });
    const exhausted = agentOutcomeSchema.parse({
      status: 'exhausted',
      summary: 'not done',
      failureType: 'budget_exhausted',
      evidence: [commandEvidence(false), { kind: 'usage', costUsd: 2.75, turns: 5 }],
      attempts: [1, 2].map((number) => ({
        number,
        sessionId: 's2',
        startedAt: `2026-07-15T00:0${number}:00.000Z`,
        endedAt: `2026-07-15T00:0${number}:30.000Z`,
        status: 'failed' as const,
        evaluations: [{ criterionId: 'tests', status: 'failed' as const, detail: 'failed', evidence: commandEvidence(false) }],
      })),
    });

    const metrics = summarizeAgentCapabilityBenchmark([
      {
        caseId: 'case-1', harnessVersion: 'v1', backend: 'claude',
        startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:01:00.000Z',
        humanInterventions: 0, outcome: achieved,
      },
      {
        caseId: 'case-2', harnessVersion: 'v1', backend: 'codex',
        startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:03:00.000Z',
        humanInterventions: 1, outcome: exhausted,
      },
    ]);

    expect(metrics).toEqual({
      total: 2,
      achieved: 1,
      solveRate: 0.5,
      firstPassRate: 0.5,
      averageAttempts: 1.5,
      humanInterventions: 1,
      averageDurationMs: 120_000,
      totalCostUsd: 4,
    });
  });

  it('keeps harness versions separate so regressions can be compared', () => {
    const outcome = agentOutcomeSchema.parse({
      status: 'achieved', summary: 'done', evidence: [commandEvidence(true)],
      attempts: [{
        number: 1, sessionId: 's1', startedAt: '2026-07-15T00:00:00.000Z',
        endedAt: '2026-07-15T00:01:00.000Z', status: 'passed',
        evaluations: [{ criterionId: 'tests', status: 'passed', detail: 'ok', evidence: commandEvidence(true) }],
      }],
    });
    const common = {
      caseId: 'case-1', backend: 'claude' as const,
      startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:01:00.000Z',
      humanInterventions: 0, outcome,
    };

    const byVersion = summarizeAgentCapabilityBenchmarkByVersion([
      { ...common, harnessVersion: 'v1' },
      { ...common, harnessVersion: 'v2' },
    ]);

    expect(Object.keys(byVersion)).toEqual(['v1', 'v2']);
    expect(byVersion.v1?.solveRate).toBe(1);
    expect(byVersion.v2?.total).toBe(1);
  });
});
