import { exec } from 'node:child_process';
import { runnerMethods, type RunnerMethodName, type RunnerParams } from '@co/protocol';
import { ClaudeSession, forkClaudeNativeSession, type DriverEmit } from './claude/driver';
import { CodexSession } from './codex/driver';
import type { ServerConnection } from './connection';
import { addSession, getSession, listSessionStates, removeSession, type RunnerSession } from './sessions';
import { provisionWorkspace } from './workspace';
import { containerExec, containerRm, containerRun } from './container';
import { ContainerSession } from './container-agent/container-session';
import { readWorkspaceFile } from './workspaceFile';

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
  const sessionsBeingForked = new Set<string>();

  function createHostSession(
    p: RunnerParams<'session.spawn'>,
    emit: DriverEmit,
    resumeNativeSessionId?: string,
  ): RunnerSession {
    switch (p.agent) {
      case 'claude':
        return new ClaudeSession(p, emit, resumeNativeSessionId);
      case 'codex':
        return new CodexSession(p, emit, resumeNativeSessionId);
      default:
        throw new Error(`agent "${p.agent}" not supported yet`);
    }
  }

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
      taskPlan: async (plan) => {
        const conn = ctx.conn;
        if (!conn) {
          return { ok: false, error: 'server connection not ready' };
        }
        try {
          return await conn.call('task.plan', { sessionId, plan });
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
      case 'workspace.read': {
        return readWorkspaceFile(runnerMethods['workspace.read'].params.parse(params));
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
        if (p.agent === 'opencode') {
          return { ok: false, error: 'agent "opencode" not supported yet' };
        }
        if (p.agent !== 'claude' && (p.designer || p.taskIntake)) {
          return { ok: false, error: `agent "${p.agent}" does not support designer/taskIntake MCP tools yet` };
        }
        if (getSession(p.sessionId)) {
          return { ok: false, error: `session already exists: ${p.sessionId}` };
        }
        const emit = makeEmit(p.sessionId);
        // 容器化会话（#37）：agent 跑在容器内；否则宿主进程内起 SDK（原路）
        const session: RunnerSession = p.container
          ? new ContainerSession(
              {
                sessionId: p.sessionId,
                containerId: p.container.containerId,
                nodePath: p.container.nodePath,
                agentMjs: p.container.agentMjs,
                agentParams: { sessionId: p.sessionId, agent: p.agent, cwd: p.cwd, prompt: p.prompt, meta: p.meta, env: p.env },
              },
              emit,
            )
          : createHostSession(p, emit);
        addSession(session);
        session.start();
        return { ok: true };
      }
      case 'session.resume': {
        const p = runnerMethods['session.resume'].params.parse(params);
        const existing = getSession(p.sessionId);
        if (existing && existing.state !== 'dead') {
          return { ok: false, error: `session already running: ${p.sessionId}` };
        }
        if (existing) {
          removeSession(p.sessionId);
        }
        const emit = makeEmit(p.sessionId);
        const spawnParams: RunnerParams<'session.spawn'> = {
          sessionId: p.sessionId,
          agent: p.agent,
          cwd: p.cwd,
          meta: p.meta,
          env: p.env,
        };
        try {
          const session = createHostSession(spawnParams, emit, p.nativeSessionId);
          addSession(session);
          session.start();
          return { ok: true };
        } catch (err) {
          removeSession(p.sessionId);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'session.fork': {
        const p = runnerMethods['session.fork'].params.parse(params);
        if (getSession(p.sessionId)) {
          return { ok: false, error: `session already exists: ${p.sessionId}` };
        }
        const source = getSession(p.sourceSessionId);
        if (source && source.state !== 'idle' && source.state !== 'dead') {
          return { ok: false, error: `source session is busy: ${p.sourceSessionId}` };
        }
        if (sessionsBeingForked.has(p.sourceSessionId)) {
          return { ok: false, error: `source session fork already in progress: ${p.sourceSessionId}` };
        }

        sessionsBeingForked.add(p.sourceSessionId);
        let forkedSession: RunnerSession | undefined;
        try {
          const emit = makeEmit(p.sessionId);
          const spawnParams: RunnerParams<'session.spawn'> = {
            sessionId: p.sessionId,
            agent: p.agent,
            cwd: p.cwd,
            meta: p.meta,
            env: p.env,
          };
          let nativeSessionId: string;
          if (p.agent === 'claude') {
            nativeSessionId = await forkClaudeNativeSession(p.nativeSessionId, p.cwd);
            forkedSession = createHostSession(spawnParams, emit, nativeSessionId);
            addSession(forkedSession);
            forkedSession.start();
          } else {
            const codex = new CodexSession(spawnParams, emit, undefined, p.nativeSessionId);
            forkedSession = codex;
            codex.start();
            nativeSessionId = await codex.waitUntilReady();
            addSession(codex);
          }
          if (nativeSessionId === p.nativeSessionId) {
            throw new Error('native fork did not create a distinct session ID');
          }
          return { ok: true, nativeSessionId };
        } catch (err) {
          forkedSession?.kill();
          removeSession(p.sessionId);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
          sessionsBeingForked.delete(p.sourceSessionId);
        }
      }
      case 'session.send': {
        const p = runnerMethods['session.send'].params.parse(params);
        if (sessionsBeingForked.has(p.sessionId)) {
          return { ok: false, error: `session fork in progress: ${p.sessionId}` };
        }
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
