import { exec } from 'node:child_process';
import { runnerMethods, type RunnerMethodName, type RunnerParams } from '@co/protocol';
import { ClaudeSession, type DriverEmit } from './claude/driver';
import type { ServerConnection } from './connection';
import { addSession, getSession, listSessionStates, removeSession } from './sessions';
import { provisionWorkspace } from './workspace';
import { containerExec, containerRm, containerRun } from './container';

const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

function execCmd(p: RunnerParams<'machine.exec'>) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    exec(
      p.cmd,
      {
        cwd: p.cwd,
        timeout: p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        let exitCode = 0;
        if (err) {
          exitCode = err.killed ? 124 : typeof err.code === 'number' ? err.code : 1;
        }
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 上下文：methods 需要经连接上报事件，连接又以 methods 为 handler——用 late-bound ref 解环 */
export interface RunnerContext {
  conn: ServerConnection | null;
}

export { listSessionStates };

export function createRunnerMethodHandler(ctx: RunnerContext) {
  function makeEmit(sessionId: string): DriverEmit {
    const call = <T>(fn: (conn: ServerConnection) => Promise<T>) => {
      const conn = ctx.conn;
      if (!conn) {
        return;
      }
      fn(conn).catch((err) => {
        console.error(`[runner] uplink failed (session ${sessionId}):`, err instanceof Error ? err.message : err);
      });
    };
    return {
      event: (envelope) => call((c) => c.call('session.event', { sessionId, envelope })),
      state: (state, nativeSessionId, usage) =>
        call((c) => c.call('session.state', { sessionId, state, nativeSessionId, usage })),
      approval: (request) => call((c) => c.call('approval.request', { request })),
      draft: async (graph) => {
        const conn = ctx.conn;
        if (!conn) {
          return { ok: false, error: 'server connection not ready' };
        }
        try {
          return await conn.call('workflow.draft', { sessionId, graph });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  }

  return async function handleRunnerMethod(method: string, params: unknown): Promise<unknown> {
    switch (method as RunnerMethodName) {
      case 'machine.exec': {
        const p = runnerMethods['machine.exec'].params.parse(params);
        return execCmd(p);
      }
      case 'workspace.provision': {
        const p = runnerMethods['workspace.provision'].params.parse(params);
        return provisionWorkspace(p);
      }
      case 'container.run': {
        return containerRun(runnerMethods['container.run'].params.parse(params));
      }
      case 'container.exec': {
        return containerExec(runnerMethods['container.exec'].params.parse(params));
      }
      case 'container.rm': {
        return containerRm(runnerMethods['container.rm'].params.parse(params));
      }
      case 'session.spawn': {
        const p = runnerMethods['session.spawn'].params.parse(params);
        if (p.agent !== 'claude') {
          return { ok: false, error: `agent "${p.agent}" not supported yet (M2)` };
        }
        if (getSession(p.sessionId)) {
          return { ok: false, error: `session already exists: ${p.sessionId}` };
        }
        const session = new ClaudeSession(p, makeEmit(p.sessionId));
        addSession(session);
        session.start();
        return { ok: true };
      }
      case 'session.send': {
        const p = runnerMethods['session.send'].params.parse(params);
        const session = getSession(p.sessionId);
        if (!session || session.state === 'dead') {
          return { ok: false, error: `session not running: ${p.sessionId}` };
        }
        session.send(p.text, p.meta);
        return { ok: true };
      }
      case 'session.kill': {
        const p = runnerMethods['session.kill'].params.parse(params);
        const session = getSession(p.sessionId);
        if (session) {
          session.kill();
          removeSession(p.sessionId);
        }
        return { ok: true };
      }
      case 'session.interrupt': {
        const p = runnerMethods['session.interrupt'].params.parse(params);
        const session = getSession(p.sessionId);
        if (!session || session.state === 'dead') {
          return { ok: false, error: `session not running: ${p.sessionId}` };
        }
        const ok = await session.interrupt();
        return { ok };
      }
      case 'approval.decide': {
        const p = runnerMethods['approval.decide'].params.parse(params);
        const session = getSession(p.sessionId);
        if (!session) {
          return { ok: false, error: `session not found: ${p.sessionId}` };
        }
        const found = session.decideApproval(p.approvalId, p.decision);
        return found ? { ok: true } : { ok: false, error: `approval not pending: ${p.approvalId}` };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  };
}
