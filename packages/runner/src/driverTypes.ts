import type {
  ApprovalRequest,
  SessionEnvelope,
  SessionState,
} from '@co/protocol';

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
  turns: number;
}

/** 所有 Agent Backend Adapter 面向 runner uplink 的归一化事件 Interface。 */
export interface DriverEmit {
  event: (envelope: SessionEnvelope) => void;
  state: (state: SessionState, nativeSessionId?: string, usage?: SessionUsage) => void;
  approval: (request: ApprovalRequest) => void;
  draft: (graph: unknown) => Promise<{ ok: boolean; error?: string }>;
  taskPlan: (plan: {
    defId: string;
    vars: Record<string, string>;
    summary: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}
