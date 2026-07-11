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
