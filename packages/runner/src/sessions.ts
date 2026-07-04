import type { SessionState } from '@co/protocol';
import type { ClaudeSession } from './claude/driver';

const sessions = new Map<string, ClaudeSession>();

export function addSession(session: ClaudeSession): void {
  sessions.set(session.sessionId, session);
}

export function getSession(sessionId: string): ClaudeSession | undefined {
  return sessions.get(sessionId);
}

export function removeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function listSessionStates(): Array<{ sessionId: string; state: SessionState }> {
  return [...sessions.values()].map((s) => ({ sessionId: s.sessionId, state: s.state }));
}
