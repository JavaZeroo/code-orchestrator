import type { ApprovalDecision, MessageMeta, SessionState } from '@co/protocol';

/** 会话驱动统一接口：ClaudeSession（宿主内进程）与 ContainerSession（容器内 agent）都实现之 */
export interface RunnerSession {
  readonly sessionId: string;
  state: SessionState;
  start(): void;
  send(text: string, meta?: MessageMeta): void;
  interrupt(): Promise<boolean>;
  kill(): void;
  decideApproval(approvalId: string, decision: ApprovalDecision): boolean;
}

const sessions = new Map<string, RunnerSession>();

export function addSession(session: RunnerSession): void {
  sessions.set(session.sessionId, session);
}

export function getSession(sessionId: string): RunnerSession | undefined {
  return sessions.get(sessionId);
}

export function removeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function listSessionStates(): Array<{ sessionId: string; state: SessionState }> {
  return [...sessions.values()].map((s) => ({ sessionId: s.sessionId, state: s.state }));
}
