import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { taskContractSchema } from '@co/protocol';
import { CapabilityOutcomePanel } from './CapabilityOutcomePanel';

describe('CapabilityOutcomePanel', () => {
  it('renders attempt progress and evaluator evidence as a semantic status region', () => {
    const contract = taskContractSchema.parse({
      acceptanceCriteria: [{ id: 'tests', description: 'unit tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      budget: { maxAttempts: 3 },
    });
    const markup = renderToStaticMarkup(
      <CapabilityOutcomePanel state={{
        kind: 'capability_loop',
        phase: 'feedback_ready',
        contract,
        attempts: [{
          number: 1,
          sessionId: 's1',
          startedAt: '2026-07-15T00:00:00.000Z',
          endedAt: '2026-07-15T00:01:00.000Z',
          status: 'failed',
          summary: 'first attempt',
          evidence: [],
          evaluations: [{
            criterionId: 'tests',
            status: 'failed',
            detail: 'command exited 1: one test failed',
            evidence: {
              kind: 'command', criterionId: 'tests', command: 'pnpm test', pass: false,
              exitCode: 1, stdout: '', stderr: 'one test failed', durationMs: 100,
            },
          }],
        }],
      }} />,
    );

    expect(markup).toContain('aria-label="Agent 能力验证"');
    expect(markup).toContain('Attempt 1 / 3');
    expect(markup).toContain('tests');
    expect(markup).toContain('one test failed');
  });
});
