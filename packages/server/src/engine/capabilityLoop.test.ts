import { describe, expect, it } from 'vitest';
import { taskContractSchema, type EvaluationResult } from '@co/protocol';
import {
  beginNextCapabilityAttempt,
  blockCapabilityLoop,
  evaluateTaskContract,
  eventBelongsToCurrentAttempt,
  markCapabilityEvaluating,
  recordCapabilityEvaluation,
  recordCapabilityFailure,
  startCapabilityLoop,
  taskContractInstruction,
  usageEvidenceForAttempt,
} from './capabilityLoop';

const contract = taskContractSchema.parse({
  acceptanceCriteria: [{
    id: 'tests',
    description: 'unit tests pass',
    evaluator: { kind: 'command', run: 'pnpm test' },
  }],
  budget: { maxAttempts: 2 },
});

function evaluation(status: EvaluationResult['status']): EvaluationResult {
  return {
    criterionId: 'tests',
    status,
    detail: status === 'passed' ? 'command exited 0' : 'command exited 1: one test failed',
    evidence: {
      kind: 'command',
      criterionId: 'tests',
      command: 'pnpm test',
      pass: status === 'passed',
      exitCode: status === 'passed' ? 0 : 1,
      stdout: '',
      stderr: status === 'passed' ? '' : 'one test failed',
      durationMs: 50,
    },
  };
}

describe('AgentCapabilityLoop', () => {
  it('persists an explicit evaluating phase before running independent checks', () => {
    const evaluating = markCapabilityEvaluating(
      startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
    );

    expect(evaluating.phase).toBe('evaluating');
    expect(evaluating.attempts.at(-1)?.status).toBe('evaluating');
    expect(markCapabilityEvaluating(evaluating)).toBe(evaluating);
  });

  it('turns failed acceptance evidence into bounded, actionable feedback', () => {
    const started = startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z');
    const transition = recordCapabilityEvaluation(started, {
      summary: 'Implementation complete',
      endedAt: '2026-07-15T00:01:00.000Z',
      evaluations: [evaluation('failed')],
    });

    expect(transition.action).toBe('retry');
    if (transition.action !== 'retry') throw new Error(`expected retry, got ${transition.action}`);
    expect(transition.state.phase).toBe('feedback_ready');
    expect(transition.state.pendingFeedback).toBe(transition.feedback);
    expect(transition.state.attempts).toEqual([
      expect.objectContaining({ number: 1, status: 'failed', summary: 'Implementation complete' }),
    ]);
    expect(transition.feedback).toContain('tests');
    expect(transition.feedback).toContain('one test failed');
  });

  it('completes only after a later attempt supplies passing evidence', () => {
    const first = recordCapabilityEvaluation(
      startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'First attempt',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('failed')],
      },
    );
    const second = beginNextCapabilityAttempt(
      first.state,
      'session-1',
      '2026-07-15T00:02:00.000Z',
    );
    expect(second.pendingFeedback).toBeUndefined();
    const completed = recordCapabilityEvaluation(second, {
      summary: 'Fixed the failing test',
      endedAt: '2026-07-15T00:03:00.000Z',
      evaluations: [evaluation('passed')],
    });

    expect(completed.action).toBe('complete');
    expect(completed.state.outcome).toEqual(expect.objectContaining({
      status: 'achieved',
      summary: 'Fixed the failing test',
    }));
    expect(completed.state.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
  });

  it('blocks on incomplete evaluator output instead of spending a repair attempt', () => {
    const twoCriteria = taskContractSchema.parse({
      acceptanceCriteria: [
        { id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } },
        { id: 'types', description: 'types pass', evaluator: { kind: 'command', run: 'pnpm typecheck' } },
      ],
    });
    const transition = recordCapabilityEvaluation(
      startCapabilityLoop(twoCriteria, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'Done',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('passed')],
      },
    );

    expect(transition.action).toBe('blocked');
    expect(transition.state.outcome?.failureType).toBe('evaluator_infrastructure');
  });

  it('cannot achieve a contract until every required evidence kind is present', () => {
    const evidenceContract = taskContractSchema.parse({
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      requiredEvidence: ['evaluation', 'agent_summary'],
    });
    const withoutSummary = recordCapabilityEvaluation(
      startCapabilityLoop(evidenceContract, 'session-1', '2026-07-15T00:00:00.000Z'),
      { summary: 'done', endedAt: '2026-07-15T00:01:00.000Z', evaluations: [evaluation('passed')] },
    );
    const withSummary = recordCapabilityEvaluation(
      startCapabilityLoop(evidenceContract, 'session-2', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'done',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('passed')],
        evidence: [{ kind: 'agent_summary', text: 'done' }],
      },
    );

    expect(withoutSummary.action).toBe('blocked');
    expect(withSummary.action).toBe('complete');
  });

  it('preserves completed attempt evidence when continuation infrastructure is unavailable', () => {
    const failed = recordCapabilityEvaluation(
      startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'Attempt finished',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('failed')],
      },
    );
    const blocked = blockCapabilityLoop(failed.state, 'Could not deliver evaluator feedback', 'agent_execution');

    expect(blocked.phase).toBe('blocked');
    expect(blocked.outcome).toEqual(expect.objectContaining({
      status: 'blocked',
      failureType: 'agent_execution',
    }));
    expect(blocked.attempts[0]?.evaluations).toHaveLength(1);
  });

  it('classifies an Agent transport failure without pretending acceptance was evaluated', () => {
    const blocked = recordCapabilityFailure(
      startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'API Error: connection reset',
        endedAt: '2026-07-15T00:00:10.000Z',
        failureType: 'agent_transport',
      },
    );

    expect(blocked.attempts[0]).toEqual(expect.objectContaining({ status: 'errored', evaluations: [] }));
    expect(blocked.outcome).toEqual(expect.objectContaining({
      status: 'blocked',
      failureType: 'agent_transport',
    }));
  });

  it('enforces turn, cost, and wall-clock budgets instead of silently accepting over-budget work', () => {
    const budgeted = taskContractSchema.parse({
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      budget: { maxAttempts: 3, maxTurns: 1, maxCostUsd: 0.5, timeoutMs: 30_000 },
    });
    const transition = recordCapabilityEvaluation(
      markCapabilityEvaluating(startCapabilityLoop(budgeted, 'session-1', '2026-07-15T00:00:00.000Z')),
      {
        summary: 'Solved, but over budget',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('passed')],
        evidence: [{ kind: 'usage', turns: 2, costUsd: 0.75 }],
      },
    );

    expect(transition.action).toBe('exhausted');
    expect(transition.state.outcome).toEqual(expect.objectContaining({
      status: 'exhausted',
      failureType: 'budget_exhausted',
    }));
    expect(transition.state.outcome?.summary).toContain('maxTurns');
    expect(transition.state.outcome?.summary).toContain('maxCostUsd');
    expect(transition.state.outcome?.summary).toContain('timeoutMs');
  });

  it('does not start another Attempt when a failed result exactly consumes the remaining budget', () => {
    const exactBudget = taskContractSchema.parse({
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      budget: { maxAttempts: 3, maxTurns: 1 },
    });
    const transition = recordCapabilityEvaluation(
      startCapabilityLoop(exactBudget, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'Not fixed yet',
        endedAt: '2026-07-15T00:00:30.000Z',
        evaluations: [evaluation('failed')],
        evidence: [{ kind: 'usage', turns: 1 }],
      },
    );

    expect(transition.action).toBe('exhausted');
    expect(transition.state.outcome?.summary).toContain('maxTurns 1/1');
  });

  it('blocks when a configured cost budget cannot be measured by the Backend', () => {
    const costBudget = taskContractSchema.parse({
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      budget: { maxAttempts: 3, maxCostUsd: 1 },
    });
    const transition = recordCapabilityEvaluation(
      startCapabilityLoop(costBudget, 'codex-session', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'Done',
        endedAt: '2026-07-15T00:00:30.000Z',
        evaluations: [evaluation('passed')],
        evidence: [{ kind: 'usage', turns: 1, inputTokens: 100 }],
      },
    );

    expect(transition.action).toBe('blocked');
    expect(transition.state.outcome).toEqual(expect.objectContaining({ failureType: 'context_missing' }));
    expect(transition.state.outcome?.summary).toContain('maxCostUsd');
  });

  it('records per-Attempt usage deltas when a session reports cumulative totals', () => {
    const first = recordCapabilityEvaluation(
      startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'first',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [evaluation('failed')],
        evidence: [{ kind: 'usage', turns: 2, costUsd: 0.5, inputTokens: 100 }],
      },
    );
    const second = beginNextCapabilityAttempt(first.state, 'session-1', '2026-07-15T00:02:00.000Z');

    expect(usageEvidenceForAttempt(second, { turns: 5, costUsd: 1.25, inputTokens: 260 })).toEqual({
      kind: 'usage',
      turns: 3,
      costUsd: 0.75,
      inputTokens: 160,
    });
  });
});

describe('command EvaluatorAdapter', () => {
  it('turns a non-zero command result into acceptance evidence', async () => {
    const results = await evaluateTaskContract(
      contract,
      'D:/repo',
      async () => ({ exitCode: 1, stdout: '', stderr: 'one test failed' }),
      (() => {
        const values = [100, 175];
        return () => values.shift() ?? 175;
      })(),
    );

    expect(results).toEqual([{
      criterionId: 'tests',
      status: 'failed',
      detail: 'command exited 1: one test failed',
      evidence: {
        kind: 'command',
        criterionId: 'tests',
        command: 'pnpm test',
        pass: false,
        exitCode: 1,
        stdout: '',
        stderr: 'one test failed',
        durationMs: 75,
      },
    }]);
  });
});

describe('TaskContract context', () => {
  it('makes success criteria, constraints, and attempt budget legible to the agent', () => {
    const instruction = taskContractInstruction(taskContractSchema.parse({
      objective: 'Fix the regression',
      acceptanceCriteria: [{
        id: 'tests',
        description: 'unit tests pass',
        evaluator: { kind: 'command', run: 'pnpm test' },
      }],
      constraints: ['Do not change the public API'],
      budget: { maxAttempts: 2 },
    }));

    expect(instruction).toContain('Fix the regression');
    expect(instruction).toContain('[tests] unit tests pass');
    expect(instruction).toContain('Do not change the public API');
    expect(instruction).toContain('2');
  });
});

describe('capability recovery', () => {
  it('ignores a turn-end event from an earlier attempt in the reused session', () => {
    const state = beginNextCapabilityAttempt(
      recordCapabilityEvaluation(
        startCapabilityLoop(contract, 'session-1', '2026-07-15T00:00:00.000Z'),
        {
          summary: 'first',
          endedAt: '2026-07-15T00:01:00.000Z',
          evaluations: [evaluation('failed')],
        },
      ).state,
      'session-1',
      '2026-07-15T00:02:00.000Z',
    );

    expect(eventBelongsToCurrentAttempt(state, new Date('2026-07-15T00:01:00.000Z'))).toBe(false);
    expect(eventBelongsToCurrentAttempt(state, new Date('2026-07-15T00:03:00.000Z'))).toBe(true);
  });
});
