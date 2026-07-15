import { describe, expect, it } from 'vitest';
import { taskContractSchema } from '@co/protocol';
import { recordCapabilityEvaluation, startCapabilityLoop } from './capabilityLoop';
import { buildContextPack, renderContextPack } from './contextPack';

describe('Agent Context Pack', () => {
  it('carries the contract, prior findings, worktree, and versioned repo instructions into the next Attempt', () => {
    const contract = taskContractSchema.parse({
      objective: 'Fix the regression',
      acceptanceCriteria: [{ id: 'tests', description: 'unit tests pass', evaluator: { kind: 'command', run: 'pnpm test' } }],
      constraints: ['Do not change the public API'],
      budget: { maxAttempts: 3 },
    });
    const failed = recordCapabilityEvaluation(
      startCapabilityLoop(contract, 's1', '2026-07-15T00:00:00.000Z'),
      {
        summary: 'Implemented a partial fix',
        endedAt: '2026-07-15T00:01:00.000Z',
        evaluations: [{
          criterionId: 'tests', status: 'failed', detail: 'one test failed',
          evidence: {
            kind: 'command', criterionId: 'tests', command: 'pnpm test', pass: false,
            exitCode: 1, stdout: '', stderr: 'one test failed', durationMs: 100,
          },
        }],
        evidence: [{ kind: 'agent_summary', text: 'Implemented a partial fix' }],
      },
    );
    const pack = buildContextPack(
      failed.state,
      'D:/repo-worktree',
      [{ path: 'AGENTS.md', sha256: 'abc123', size: 512 }],
      { gitHead: '95cbe39', dirty: true },
      '2026-07-15T00:01:01.000Z',
    );
    const rendered = renderContextPack(pack);

    expect(pack).toMatchObject({ version: 1, attempt: { number: 2, maxAttempts: 3 } });
    expect(rendered).toContain('Fix the regression');
    expect(rendered).toContain('Implemented a partial fix');
    expect(rendered).toContain('one test failed');
    expect(rendered).toContain('AGENTS.md');
    expect(rendered).toContain('abc123');
    expect(rendered).toContain('95cbe39');
    expect(rendered).toContain('dirty');
  });
});
