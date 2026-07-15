import { describe, expect, it } from 'vitest';
import {
  agentOutcomeSchema,
  agentSummaryEvidenceSchema,
  capabilityLoopStateSchema,
  taskContractSchema,
} from './capability';

describe('TaskContract', () => {
  it('parses a command-backed success contract with safe defaults', () => {
    expect(taskContractSchema.parse({
      acceptanceCriteria: [{
        id: 'unit-tests',
        description: 'server unit tests pass',
        evaluator: { kind: 'command', run: 'pnpm --filter @co/server test:unit' },
      }],
    })).toEqual({
      version: 1,
      acceptanceCriteria: [{
        id: 'unit-tests',
        description: 'server unit tests pass',
        evaluator: {
          kind: 'command',
          run: 'pnpm --filter @co/server test:unit',
          timeoutMs: 300_000,
        },
      }],
      requiredEvidence: ['evaluation'],
      constraints: [],
      budget: { maxAttempts: 3 },
    });
  });
});

describe('AgentOutcome', () => {
  it('requires an achieved result to carry attempts and evaluator evidence', () => {
    const outcome = agentOutcomeSchema.parse({
      status: 'achieved',
      summary: 'Implemented the change and unit tests pass.',
      evidence: [{
        kind: 'command',
        criterionId: 'unit-tests',
        command: 'pnpm test',
        pass: true,
        exitCode: 0,
        stdout: '12 tests passed',
        stderr: '',
        durationMs: 1200,
      }],
      attempts: [{
        number: 1,
        sessionId: 'session-1',
        startedAt: '2026-07-15T00:00:00.000Z',
        endedAt: '2026-07-15T00:01:00.000Z',
        summary: 'Done',
        status: 'passed',
        evaluations: [{
          criterionId: 'unit-tests',
          status: 'passed',
          detail: 'command exited 0',
          evidence: {
            kind: 'command',
            criterionId: 'unit-tests',
            command: 'pnpm test',
            pass: true,
            exitCode: 0,
            stdout: '12 tests passed',
            stderr: '',
            durationMs: 1200,
          },
        }],
      }],
    });

    expect(outcome.status).toBe('achieved');
    expect(outcome.attempts[0]?.evaluations[0]?.status).toBe('passed');
  });

  it('rejects empty agent summaries and malformed persisted loop state', () => {
    expect(() => agentSummaryEvidenceSchema.parse({ kind: 'agent_summary', text: '   ' })).toThrow();
    expect(() => capabilityLoopStateSchema.parse({ kind: 'capability_loop', phase: 'attempt_running' })).toThrow();
  });
});
