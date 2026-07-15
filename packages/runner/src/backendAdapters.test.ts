import { describe, expect, it } from 'vitest';
import { backendCapabilityError, getRunnerBackendAdapter } from './backendAdapters';

describe('RunnerBackendAdapter registry', () => {
  it('negotiates spawn capabilities without exposing backend switches to callers', () => {
    const claude = getRunnerBackendAdapter('claude');
    const codex = getRunnerBackendAdapter('codex');

    expect(claude?.validateSpawn({
      sessionId: 'claude-host',
      agent: 'claude',
      cwd: '/tmp/work',
      designer: true,
    })).toBeNull();
    expect(claude?.validateSpawn({
      sessionId: 'claude-container',
      agent: 'claude',
      cwd: '/workspace',
      designer: true,
      container: { containerId: 'c1', nodePath: '/node', agentMjs: '/agent.mjs' },
    })).toContain('host session');
    expect(codex?.validateSpawn({
      sessionId: 'codex-host',
      agent: 'codex',
      cwd: '/tmp/work',
      designer: true,
    })).toContain('designerTools');
    expect(getRunnerBackendAdapter('opencode')).toBeNull();
  });

  it('provides one capability rejection path for lifecycle methods such as resume', () => {
    const descriptor = {
      name: 'codex' as const,
      capabilities: {
        hostSession: true,
        containerSession: true,
        resume: false,
        fork: true,
        interrupt: true,
        designerTools: false,
        taskIntakeTools: false,
      },
      constraints: [],
    };

    expect(backendCapabilityError(descriptor, 'resume')).toBe('agent "codex" does not support resume');
  });
});
