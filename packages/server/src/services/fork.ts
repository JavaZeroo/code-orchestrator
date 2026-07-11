/**
 * 手动宿主会话分叉：让原 runner 用后端原生能力复制完整历史，再为目标会话
 * 建立独立的数据库记录和 transcript。源会话与源事件流始终只读。
 */

import { createId } from '@paralleldrive/cuid2';
import type { RunnerParams, RunnerResult } from '@co/protocol';
import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { callRunner, isRunnerOnline } from '../ws/runnerHub';
import { resolveModel } from './spawn';

const TITLE_MAX_LENGTH = 120;
const FORK_TITLE_SUFFIX = ' (fork)';

export class ForkError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ForkSessionRecord {
  id: string;
  machineId: string;
  agent: string;
  model: string | null;
  role: string | null;
  cwd: string;
  title: string | null;
  state: string;
  nativeSessionId: string | null;
  runId: string | null;
  projectId: string | null;
  containerId: string | null;
  archivedAt: Date | null;
  createdBy: string | null;
}

export interface ForkTargetRecord {
  id: string;
  machineId: string;
  agent: 'claude' | 'codex';
  model: string | null;
  role: string | null;
  cwd: string;
  title: string;
  state: 'starting';
  projectId: string | null;
  createdBy: string | null;
}

export interface ForkDependencies {
  load: (sessionId: string) => Promise<ForkSessionRecord | null>;
  runnerOnline: (machineId: string) => boolean;
  resolveModel: (model?: string, createdBy?: string) => Promise<{ model?: string; env?: Record<string, string> }>;
  prepare: (source: ForkSessionRecord, target: ForkTargetRecord) => Promise<void>;
  finalize: (sessionId: string, nativeSessionId: string) => Promise<void>;
  rollback: (sessionId: string) => Promise<void>;
  forkRunner: (
    machineId: string,
    params: RunnerParams<'session.fork'>,
  ) => Promise<RunnerResult<'session.fork'>>;
  killRunner: (machineId: string, sessionId: string) => Promise<void>;
  createSessionId: () => string;
}

export function forkBlockReason(session: ForkSessionRecord, runnerOnline: boolean): string | null {
  if (session.archivedAt !== null) return 'archived sessions must be restored before forking';
  if (session.state !== 'idle' && session.state !== 'dead') return `session is busy: ${session.state}`;
  if (session.runId !== null) return 'workflow sessions cannot be forked manually';
  if (session.containerId !== null) return 'container sessions cannot be forked';
  if (!session.nativeSessionId) return 'session has no native session ID';
  if (session.agent !== 'claude' && session.agent !== 'codex') return `agent "${session.agent}" cannot be forked`;
  if (!runnerOnline) return `original runner is offline: ${session.machineId}`;
  return null;
}

export function forkedSessionTitle(session: Pick<ForkSessionRecord, 'title' | 'cwd'>): string {
  const cwdName = session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd;
  const base = session.title?.trim() || cwdName || 'Session';
  return `${base.slice(0, TITLE_MAX_LENGTH - FORK_TITLE_SUFFIX.length)}${FORK_TITLE_SUFFIX}`;
}

const productionDependencies: ForkDependencies = {
  async load(sessionId) {
    const rows = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    return rows[0] ?? null;
  },
  runnerOnline: isRunnerOnline,
  resolveModel,
  async prepare(source, target) {
    await getDb().transaction(async (tx) => {
      const rows = await tx.select().from(schema.sessions).where(eq(schema.sessions.id, source.id)).limit(1);
      const current = rows[0];
      if (!current) {
        throw new ForkError(404, `session not found: ${source.id}`);
      }
      const blocked = forkBlockReason(current, isRunnerOnline(current.machineId));
      if (blocked) {
        throw new ForkError(409, blocked);
      }

      await tx.insert(schema.sessions).values(target);
      await tx.insert(schema.events).values({
        sessionId: target.id,
        type: 'session.created',
        payload: {
          machineId: target.machineId,
          cwd: target.cwd,
          projectId: target.projectId,
          forkedFromSessionId: source.id,
        },
      });

      const transcript = await tx
        .select({ type: schema.events.type, payload: schema.events.payload, createdAt: schema.events.createdAt })
        .from(schema.events)
        .where(eq(schema.events.sessionId, source.id))
        .orderBy(asc(schema.events.seq));
      const messages = transcript.filter((event) => event.type === 'session.message');
      if (messages.length > 0) {
        await tx.insert(schema.events).values(
          messages.map((event) => ({
            sessionId: target.id,
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt,
          })),
        );
      }
    });
  },
  async finalize(sessionId, nativeSessionId) {
    const rows = await getDb()
      .update(schema.sessions)
      .set({ nativeSessionId })
      .where(eq(schema.sessions.id, sessionId))
      .returning({ id: schema.sessions.id });
    if (!rows[0]) {
      throw new Error(`fork target disappeared: ${sessionId}`);
    }
  },
  async rollback(sessionId) {
    await getDb().transaction(async (tx) => {
      await tx.delete(schema.events).where(eq(schema.events.sessionId, sessionId));
      await tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    });
  },
  forkRunner: (machineId, params) => callRunner(machineId, 'session.fork', params),
  async killRunner(machineId, sessionId) {
    await callRunner(machineId, 'session.kill', { sessionId });
  },
  createSessionId: createId,
};

export async function forkSessionWithDependencies(
  sourceSessionId: string,
  requestedBy: string | undefined,
  deps: ForkDependencies,
): Promise<{ sessionId: string }> {
  const source = await deps.load(sourceSessionId);
  if (!source) {
    throw new ForkError(404, `session not found: ${sourceSessionId}`);
  }
  const blocked = forkBlockReason(source, deps.runnerOnline(source.machineId));
  if (blocked) {
    throw new ForkError(409, blocked);
  }

  const resolved = await deps.resolveModel(source.model ?? undefined, requestedBy ?? source.createdBy ?? undefined);
  const sessionId = deps.createSessionId();
  const target: ForkTargetRecord = {
    id: sessionId,
    machineId: source.machineId,
    agent: source.agent as 'claude' | 'codex',
    model: resolved.model ?? source.model,
    role: source.role,
    cwd: source.cwd,
    title: forkedSessionTitle(source),
    state: 'starting',
    projectId: source.projectId,
    createdBy: requestedBy ?? source.createdBy,
  };

  let prepared = false;
  let runnerStarted = false;
  try {
    await deps.prepare(source, target);
    prepared = true;
    if (!deps.runnerOnline(source.machineId)) {
      throw new ForkError(409, `original runner is offline: ${source.machineId}`);
    }
    const result = await deps.forkRunner(source.machineId, {
      sourceSessionId: source.id,
      sessionId,
      agent: target.agent,
      cwd: source.cwd,
      nativeSessionId: source.nativeSessionId!,
      meta: {
        model: resolved.model ?? source.model,
        permissionMode: 'bypassPermissions',
      },
      env: resolved.env,
    });
    if (!result.ok) {
      throw new ForkError(502, result.error ?? 'runner failed to fork session');
    }
    runnerStarted = true;
    if (!result.nativeSessionId || result.nativeSessionId === source.nativeSessionId) {
      throw new ForkError(502, 'runner did not return a distinct native session ID');
    }
    await deps.finalize(sessionId, result.nativeSessionId);
    return { sessionId };
  } catch (err) {
    if (runnerStarted) {
      await deps.killRunner(source.machineId, sessionId).catch(() => {});
    }
    if (prepared) {
      await deps.rollback(sessionId).catch(() => {});
    }
    if (err instanceof ForkError) throw err;
    throw new ForkError(502, `fork failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function forkSession(
  sourceSessionId: string,
  requestedBy?: string,
): Promise<{ sessionId: string }> {
  return forkSessionWithDependencies(sourceSessionId, requestedBy, productionDependencies);
}
