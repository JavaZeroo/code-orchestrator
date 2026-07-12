import type { SessionNotePayload } from '@co/protocol';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { publish, type OrchEvent } from '../events';

export interface SessionNoteEvent {
  seq: number;
  type: 'session.note';
  sessionId: string;
  payload: SessionNotePayload;
}

export interface SessionNoteDependencies {
  sessionExists: (sessionId: string) => Promise<boolean>;
  publishEvent: (event: OrchEvent) => Promise<number>;
}

export class SessionNoteError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const defaultDependencies: SessionNoteDependencies = {
  async sessionExists(sessionId) {
    const rows = await getDb()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    return rows.length === 1;
  },
  publishEvent: publish,
};

export async function appendSessionNoteWithDependencies(
  sessionId: string,
  payload: SessionNotePayload,
  dependencies: SessionNoteDependencies,
): Promise<SessionNoteEvent> {
  if (!(await dependencies.sessionExists(sessionId))) {
    throw new SessionNoteError(404, 'session not found');
  }
  const event = { type: 'session.note' as const, sessionId, payload };
  const seq = await dependencies.publishEvent(event);
  return { ...event, seq };
}

export function appendSessionNote(sessionId: string, payload: SessionNotePayload): Promise<SessionNoteEvent> {
  return appendSessionNoteWithDependencies(sessionId, payload, defaultDependencies);
}
