/**
 * 手动宿主会话恢复：以 sessions.state 的条件更新抢占一次恢复权，再让原 runner
 * 用 nativeSessionId 重新接入 Claude/Codex 上下文。会话 id 与事件流始终复用原记录。
 */

import type { RunnerParams, RunnerResult } from '@co/protocol';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { callRunner, isRunnerOnline } from '../ws/runnerHub';
import { resolveModel } from './spawn';

export class ResumeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ResumeSessionRecord {
  id: string;
  machineId: string;
  agent: string;
  model: string | null;
  cwd: string;
  state: string;
  nativeSessionId: string | null;
  runId: string | null;
  containerId: string | null;
  createdBy: string | null;
}

export interface ResumeDependencies {
  load: (sessionId: string) => Promise<ResumeSessionRecord | null>;
  /** 原子 dead → starting；条件不再成立时返回 null */
  claim: (sessionId: string) => Promise<ResumeSessionRecord | null>;
  rollback: (sessionId: string) => Promise<void>;
  runnerOnline: (machineId: string) => boolean;
  resolveModel: (model?: string, createdBy?: string) => Promise<{ model?: string; env?: Record<string, string> }>;
  resumeRunner: (
    machineId: string,
    params: RunnerParams<'session.resume'>,
  ) => Promise<RunnerResult<'session.resume'>>;
}

export function resumeBlockReason(session: ResumeSessionRecord, runnerOnline: boolean): string | null {
  if (session.state !== 'dead') return 'session is not dead';
  if (session.runId !== null) return 'workflow sessions cannot be resumed manually';
  if (session.containerId !== null) return 'container sessions cannot be resumed';
  if (!session.nativeSessionId) return 'session has no native session ID';
  if (session.agent !== 'claude' && session.agent !== 'codex') return `agent "${session.agent}" cannot be resumed`;
  if (!runnerOnline) return `original runner is offline: ${session.machineId}`;
  return null;
}

const productionDependencies: ResumeDependencies = {
  async load(sessionId) {
    const rows = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    return rows[0] ?? null;
  },
  async claim(sessionId) {
    const rows = await getDb()
      .update(schema.sessions)
      .set({ state: 'starting' })
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          eq(schema.sessions.state, 'dead'),
          isNull(schema.sessions.runId),
          isNull(schema.sessions.containerId),
          isNotNull(schema.sessions.nativeSessionId),
          inArray(schema.sessions.agent, ['claude', 'codex']),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async rollback(sessionId) {
    await getDb()
      .update(schema.sessions)
      .set({ state: 'dead' })
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.state, 'starting')));
  },
  runnerOnline: isRunnerOnline,
  resolveModel,
  resumeRunner: (machineId, params) => callRunner(machineId, 'session.resume', params),
};

export async function resumeSessionWithDependencies(
  sessionId: string,
  deps: ResumeDependencies,
): Promise<{ sessionId: string }> {
  const found = await deps.load(sessionId);
  if (!found) {
    throw new ResumeError(404, `session not found: ${sessionId}`);
  }
  const blocked = resumeBlockReason(found, deps.runnerOnline(found.machineId));
  if (blocked) {
    throw new ResumeError(409, blocked);
  }

  // 先解析凭据，避免配置错误占住 starting；最终并发裁决仍由 claim 完成。
  const resolved = await deps.resolveModel(found.model ?? undefined, found.createdBy ?? undefined);
  const claimed = await deps.claim(sessionId);
  if (!claimed) {
    throw new ResumeError(409, 'session is no longer eligible to resume');
  }

  try {
    if (!deps.runnerOnline(claimed.machineId)) {
      throw new ResumeError(409, `original runner is offline: ${claimed.machineId}`);
    }
    if (!claimed.nativeSessionId || (claimed.agent !== 'claude' && claimed.agent !== 'codex')) {
      throw new ResumeError(409, 'session is no longer eligible to resume');
    }
    const result = await deps.resumeRunner(claimed.machineId, {
      sessionId: claimed.id,
      agent: claimed.agent,
      cwd: claimed.cwd,
      nativeSessionId: claimed.nativeSessionId,
      meta: {
        model: resolved.model ?? claimed.model,
        permissionMode: 'bypassPermissions',
      },
      env: resolved.env,
    });
    if (!result.ok) {
      throw new ResumeError(502, result.error ?? 'runner failed to resume session');
    }
    return { sessionId: claimed.id };
  } catch (err) {
    await deps.rollback(sessionId).catch(() => {});
    if (err instanceof ResumeError) throw err;
    throw new ResumeError(502, `resume failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function resumeSession(sessionId: string): Promise<{ sessionId: string }> {
  return resumeSessionWithDependencies(sessionId, productionDependencies);
}
