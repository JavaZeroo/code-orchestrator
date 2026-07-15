import { describe, expect, it } from 'vitest';
import { evaluatorRunnerCall, repositoryInstructionRunnerCall } from './capabilityWorkspace';

describe('Capability WorkspaceAdapter', () => {
  it('runs host-session evaluators on the machine worktree', () => {
    expect(evaluatorRunnerCall(
      { cwd: '/data/co/wt/s1', containerId: null },
      { command: 'pnpm test', cwd: '/data/co/wt/s1', timeoutMs: 300_000 },
    )).toEqual({
      method: 'machine.exec',
      params: { cmd: 'pnpm test', cwd: '/data/co/wt/s1', timeoutMs: 300_000 },
    });
  });

  it('runs container-session evaluators inside the owning container', () => {
    expect(evaluatorRunnerCall(
      { cwd: '/workspace', containerId: 'container-1' },
      { command: 'pnpm test', cwd: '/workspace', timeoutMs: 300_000 },
    )).toEqual({
      method: 'container.exec',
      params: { containerId: 'container-1', cmd: 'pnpm test', workdir: '/workspace', timeoutMs: 300_000 },
    });
  });

  it('reads repository instructions through the same owning workspace boundary', () => {
    expect(repositoryInstructionRunnerCall(
      { cwd: '/workspace', containerId: 'container-1' },
      'AGENTS.md',
    )).toEqual({
      method: 'container.exec',
      params: {
        containerId: 'container-1',
        workdir: '/workspace',
        cmd: "if [ -f 'AGENTS.md' ]; then printf 'FOUND\\n'; base64 'AGENTS.md' | tr -d '\\n'; fi",
        timeoutMs: 10_000,
      },
    });
    expect(repositoryInstructionRunnerCall(
      { cwd: '/data/co/wt/s1', containerId: null },
      'AGENTS.md',
    )).toEqual({
      method: 'workspace.read',
      params: { root: '/data/co/wt/s1', path: 'AGENTS.md' },
    });
  });
});
