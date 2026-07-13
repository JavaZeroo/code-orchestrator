import { describe, expect, it } from 'vitest';
import {
  approvalDecisionSchema,
  jsonRpcMessageSchema,
  runnerMethods,
  serverMethods,
} from './index';

describe('jsonRpcMessageSchema', () => {
  it('accepts requests, notifications, and responses', () => {
    expect(jsonRpcMessageSchema.parse({ jsonrpc: '2.0', id: '1', method: 'machine.exec', params: {} })).toMatchObject({
      id: '1',
      method: 'machine.exec',
    });
    expect(jsonRpcMessageSchema.parse({ jsonrpc: '2.0', method: 'machine.heartbeat' })).toMatchObject({
      method: 'machine.heartbeat',
    });
    expect(jsonRpcMessageSchema.parse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toMatchObject({
      id: 1,
      result: { ok: true },
    });
  });

  it('rejects non-2.0 envelopes', () => {
    expect(() => jsonRpcMessageSchema.parse({ jsonrpc: '1.0', id: '1', method: 'x' })).toThrow();
  });
});

describe('runnerMethods contracts', () => {
  it('validates container.run defaults', () => {
    const parsed = runnerMethods['container.run'].params.parse({ image: 'node:22' });
    expect(parsed.mounts).toEqual([]);
    expect(parsed.devices).toEqual([]);
    expect(parsed.extraArgs).toEqual([]);
  });

  it('rejects invalid machine.exec timeout', () => {
    expect(() => runnerMethods['machine.exec'].params.parse({ cmd: 'pwd', timeoutMs: 0 })).toThrow();
  });

  it('validates bounded workspace file reads for host and container sessions', () => {
    expect(runnerMethods['workspace.read'].params.parse({ root: '/work', path: 'out/result.bin' })).toEqual({
      root: '/work', path: 'out/result.bin',
    });
    expect(runnerMethods['workspace.read'].params.parse({ root: '/workspace', path: 'x', containerId: 'c1' }))
      .toMatchObject({ containerId: 'c1' });
    expect(() => runnerMethods['workspace.read'].params.parse({ root: '/work', path: '' })).toThrow();
  });

  it('validates bounded workspace directory archives for host and container sessions', () => {
    expect(runnerMethods['workspace.archive'].params.parse({ root: '/work', path: 'out/reports' })).toEqual({
      root: '/work', path: 'out/reports',
    });
    expect(runnerMethods['workspace.archive'].params.parse({
      root: '/workspace', path: 'results', containerId: 'c1',
    })).toMatchObject({ containerId: 'c1' });
    expect(() => runnerMethods['workspace.archive'].params.parse({ root: '/work', path: '' })).toThrow();
    expect(() => runnerMethods['workspace.archive'].result.parse({
      ok: true, basename: 'reports.tar.gz', size: 10 * 1024 * 1024 + 1, data: '',
    })).toThrow();
  });

  it('validates bounded workspace file writes for host and container sessions', () => {
    const data = Buffer.from([0, 1, 255]).toString('base64');
    expect(runnerMethods['workspace.write'].params.parse({ root: '/work', path: 'out/result.bin', data, size: 3 }))
      .toEqual({ root: '/work', path: 'out/result.bin', data, size: 3 });
    expect(runnerMethods['workspace.write'].params.parse({
      root: '/workspace', path: 'x', data: '', size: 0, containerId: 'c1',
    })).toMatchObject({ containerId: 'c1' });
    expect(() => runnerMethods['workspace.write'].params.parse({
      root: '/work', path: 'large.bin', data: '', size: 10 * 1024 * 1024 + 1,
    })).toThrow();
    expect(() => runnerMethods['workspace.write'].params.parse({
      root: '/work', path: 'bad.bin', data: 'not base64!', size: 3,
    })).toThrow();
  });

  it('validates workspace file deletion for host and container sessions', () => {
    expect(runnerMethods['workspace.delete'].params.parse({ root: '/work', path: 'out/result.bin' }))
      .toEqual({ root: '/work', path: 'out/result.bin' });
    expect(runnerMethods['workspace.delete'].params.parse({ root: '/workspace', path: 'x', containerId: 'c1' }))
      .toEqual({ root: '/workspace', path: 'x', containerId: 'c1' });
    expect(() => runnerMethods['workspace.delete'].params.parse({ root: '/work', path: '' })).toThrow();
    expect(runnerMethods['workspace.delete'].result.parse({ ok: false, error: 'not a regular file' }))
      .toEqual({ ok: false, error: 'not a regular file' });
  });

  it('validates workspace directory creation for host and container sessions', () => {
    expect(runnerMethods['workspace.mkdir'].params.parse({ root: '/work', path: 'reports/daily' }))
      .toEqual({ root: '/work', path: 'reports/daily' });
    expect(runnerMethods['workspace.mkdir'].params.parse({
      root: '/workspace', path: 'reports', containerId: 'c1',
    })).toEqual({ root: '/workspace', path: 'reports', containerId: 'c1' });
    expect(() => runnerMethods['workspace.mkdir'].params.parse({ root: '/work', path: '' })).toThrow();
  });

  it('validates workspace copies for host and container sessions', () => {
    expect(runnerMethods['workspace.copy'].params.parse({
      root: '/work', path: 'reports/draft', destinationPath: 'archive/draft',
    })).toEqual({ root: '/work', path: 'reports/draft', destinationPath: 'archive/draft' });
    expect(runnerMethods['workspace.copy'].params.parse({
      root: '/workspace', path: 'reports', destinationPath: 'reports-copy', containerId: 'c1',
    })).toMatchObject({ containerId: 'c1', destinationPath: 'reports-copy' });
    expect(() => runnerMethods['workspace.copy'].params.parse({
      root: '/work', path: '', destinationPath: 'copy',
    })).toThrow();
    expect(runnerMethods['workspace.copy'].result.parse({ ok: true, path: 'archive/draft' }))
      .toEqual({ ok: true, path: 'archive/draft' });
  });

  it('validates workspace directory listings for host and container sessions', () => {
    expect(runnerMethods['workspace.list'].params.parse({ root: '/work' })).toEqual({ root: '/work', path: '' });
    expect(runnerMethods['workspace.list'].params.parse({ root: '/workspace', path: 'out', containerId: 'c1' }))
      .toEqual({ root: '/workspace', path: 'out', containerId: 'c1' });
    expect(runnerMethods['workspace.list'].result.parse({
      ok: true,
      path: 'out',
      entries: [{ name: 'models', type: 'directory' }, { name: 'result.bin', type: 'file', size: 42 }],
      truncated: false,
    })).toMatchObject({ entries: [{ type: 'directory' }, { type: 'file', size: 42 }] });
  });

  it('validates bounded workspace filename searches for host and container sessions', () => {
    expect(runnerMethods['workspace.search'].params.parse({ root: '/work', query: ' report ' }))
      .toEqual({ root: '/work', query: 'report' });
    expect(runnerMethods['workspace.search'].params.parse({ root: '/workspace', query: 'model', containerId: 'c1' }))
      .toEqual({ root: '/workspace', query: 'model', containerId: 'c1' });
    expect(() => runnerMethods['workspace.search'].params.parse({ root: '/work', query: ' ' })).toThrow();
    expect(runnerMethods['workspace.search'].result.parse({
      ok: true,
      matches: [{ path: 'reports/final.md', type: 'file', size: 42 }, { path: 'reports/archive', type: 'directory' }],
      truncated: false,
    })).toMatchObject({ matches: [{ type: 'file', size: 42 }, { type: 'directory' }] });
    expect(() => runnerMethods['workspace.search'].result.parse({
      ok: true,
      matches: Array.from({ length: 101 }, (_, index) => ({ path: `match-${index}`, type: 'file' })),
      truncated: true,
    })).toThrow();
  });

  it('validates bounded workspace content matches with navigable lines', () => {
    expect(runnerMethods['workspace.searchContent'].params.parse({ root: '/work', query: ' ready ' }))
      .toEqual({ root: '/work', query: 'ready' });
    expect(runnerMethods['workspace.searchContent'].result.parse({
      ok: true, matches: [{ path: 'src/main.ts', line: 7, preview: 'const ready = true;' }], truncated: false,
    })).toMatchObject({ matches: [{ path: 'src/main.ts', line: 7 }] });
    expect(() => runnerMethods['workspace.searchContent'].result.parse({
      ok: true, matches: [{ path: 'bad', line: 0, preview: '' }], truncated: false,
    })).toThrow();
  });

  it('accepts containerized session.spawn parameters', () => {
    const parsed = runnerMethods['session.spawn'].params.parse({
      sessionId: 's1',
      agent: 'claude',
      cwd: '/workspace',
      container: { containerId: 'c1', nodePath: '/opt/co/node', agentMjs: '/opt/co/agent.mjs' },
    });
    expect(parsed.container?.containerId).toBe('c1');
  });

  it('validates host session resume parameters', () => {
    expect(
      runnerMethods['session.resume'].params.parse({
        sessionId: 's1',
        agent: 'codex',
        cwd: '/workspace',
        nativeSessionId: 'thread-1',
      }),
    ).toMatchObject({ sessionId: 's1', agent: 'codex', nativeSessionId: 'thread-1' });
    expect(() =>
      runnerMethods['session.resume'].params.parse({
        sessionId: 's1',
        agent: 'opencode',
        cwd: '/workspace',
        nativeSessionId: 'native-1',
      }),
    ).toThrow();
  });

  it('validates full-history host session fork parameters', () => {
    expect(
      runnerMethods['session.fork'].params.parse({
        sourceSessionId: 'source-1',
        sessionId: 'fork-1',
        agent: 'claude',
        cwd: '/workspace',
        nativeSessionId: 'native-source-1',
      }),
    ).toMatchObject({
      sourceSessionId: 'source-1',
      sessionId: 'fork-1',
      nativeSessionId: 'native-source-1',
    });
    expect(() =>
      runnerMethods['session.fork'].params.parse({
        sourceSessionId: 'same-session',
        sessionId: 'same-session',
        agent: 'codex',
        cwd: '/workspace',
        nativeSessionId: 'thread-1',
      }),
    ).toThrow();
  });
});

describe('serverMethods contracts', () => {
  it('validates heartbeat defaults', () => {
    const parsed = serverMethods['machine.heartbeat'].params.parse({ machineId: 'm1' });
    expect(parsed.sessions).toEqual([]);
  });

  it('rejects invalid workflow task plan vars', () => {
    expect(() =>
      serverMethods['task.plan'].params.parse({
        sessionId: 's1',
        plan: { defId: 'd1', vars: { ok: 1 }, summary: 'run it' },
      }),
    ).toThrow();
  });
});

describe('approvalDecisionSchema', () => {
  it('preserves allow and deny decision payloads', () => {
    expect(approvalDecisionSchema.parse({ behavior: 'allow', updatedInput: { cmd: 'pnpm test' } })).toEqual({
      behavior: 'allow',
      updatedInput: { cmd: 'pnpm test' },
    });
    expect(approvalDecisionSchema.parse({ behavior: 'deny', message: 'too risky' })).toEqual({
      behavior: 'deny',
      message: 'too risky',
    });
  });
});
