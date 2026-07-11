/**
 * 已结束手动会话的归档状态转换。归档只更新 sessions 的时间戳，事件流保持原样；
 * 条件更新负责在并发请求或迟到的 runner 状态变更下重新裁决资格。
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

export class SessionArchiveError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionArchiveRecord {
  id: string;
  state: string;
  runId: string | null;
  archivedAt: Date | null;
}

export interface SessionArchiveDependencies {
  load: (sessionId: string) => Promise<SessionArchiveRecord | null>;
  archive: (sessionId: string) => Promise<SessionArchiveRecord | null>;
  restore: (sessionId: string) => Promise<SessionArchiveRecord | null>;
}

export function archiveBlockReason(session: SessionArchiveRecord): string | null {
  if (session.archivedAt !== null) return 'session is already archived';
  if (session.runId !== null) return 'workflow sessions cannot be archived';
  if (session.state !== 'dead') return `session is still active: ${session.state}`;
  return null;
}

export function restoreBlockReason(session: SessionArchiveRecord): string | null {
  if (session.archivedAt === null) return 'session is not archived';
  return null;
}

const productionDependencies: SessionArchiveDependencies = {
  async load(sessionId) {
    const rows = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    return rows[0] ?? null;
  },
  async archive(sessionId) {
    const rows = await getDb()
      .update(schema.sessions)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          eq(schema.sessions.state, 'dead'),
          isNull(schema.sessions.runId),
          isNull(schema.sessions.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async restore(sessionId) {
    const rows = await getDb()
      .update(schema.sessions)
      .set({ archivedAt: null })
      .where(and(eq(schema.sessions.id, sessionId), isNotNull(schema.sessions.archivedAt)))
      .returning();
    return rows[0] ?? null;
  },
};

export async function archiveSessionWithDependencies(
  sessionId: string,
  deps: SessionArchiveDependencies,
): Promise<SessionArchiveRecord> {
  const found = await deps.load(sessionId);
  if (!found) {
    throw new SessionArchiveError(404, `session not found: ${sessionId}`);
  }
  const blocked = archiveBlockReason(found);
  if (blocked) {
    throw new SessionArchiveError(409, blocked);
  }
  const archived = await deps.archive(sessionId);
  if (!archived) {
    throw new SessionArchiveError(409, 'session is no longer eligible to archive');
  }
  return archived;
}

export async function restoreSessionWithDependencies(
  sessionId: string,
  deps: SessionArchiveDependencies,
): Promise<SessionArchiveRecord> {
  const found = await deps.load(sessionId);
  if (!found) {
    throw new SessionArchiveError(404, `session not found: ${sessionId}`);
  }
  const blocked = restoreBlockReason(found);
  if (blocked) {
    throw new SessionArchiveError(409, blocked);
  }
  const restored = await deps.restore(sessionId);
  if (!restored) {
    throw new SessionArchiveError(409, 'session is no longer eligible to restore');
  }
  return restored;
}

export function archiveSession(sessionId: string): Promise<SessionArchiveRecord> {
  return archiveSessionWithDependencies(sessionId, productionDependencies);
}

export function restoreSession(sessionId: string): Promise<SessionArchiveRecord> {
  return restoreSessionWithDependencies(sessionId, productionDependencies);
}
