import type { ApprovalRequest, SessionEnvelope, SessionState, WorkflowDef } from '@co/protocol';

export interface EventRow {
  seq: number;
  type: string;
  sessionId?: string | null;
  payload: unknown;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

export interface SessionRow {
  id: string;
  machineId: string;
  agent: string;
  model: string | null;
  cwd: string;
  state: SessionState | string;
  nativeSessionId: string | null;
  runId: string | null;
  nodeId: string | null;
  usage: SessionUsage | null;
  createdAt: string;
}

export interface MachineRow {
  id: string;
  name: string;
  labels: string[];
  codeServerUrl?: string;
}

export type { ApprovalRequest, SessionEnvelope, SessionState, WorkflowDef };

export interface WorkflowDefRow {
  id: string;
  name: string;
  version: number;
  graph: WorkflowDef;
  createdVia: string;
  createdAt: string;
}

export interface RunRow {
  id: string;
  defId: string;
  status: string;
  context: { vars: Record<string, string>; outputs: Record<string, string> };
  startedAt: string;
  endedAt: string | null;
}

export interface NodeStateRow {
  runId: string;
  nodeId: string;
  status: string;
  sessionId: string | null;
  output: { summary?: string; error?: string; verdict?: string; minutes?: string } | null;
}

export interface ApprovalRow {
  id: string;
  kind: 'tool' | 'gate';
  sessionId: string | null;
  runId: string | null;
  nodeId: string | null;
  title: string;
  status: string;
}

export type ForgeKind = 'gitcode' | 'github';

export interface TriggerRow {
  id: string;
  forge: ForgeKind;
  repo: string;
  defId: string;
  defName: string | null;
  labels: string[];
  titlePattern: string | null;
  vars: Record<string, string>;
  backfill: 'yes' | 'no';
  enabled: 'yes' | 'no';
  lastPolledAt: string | null;
  createdAt: string;
  /** 命中的需求数（requirement_intakes 行数） */
  intakeCount: number;
  /** 最近一次命中时间（无命中为 null） */
  lastIntakeAt: string | null;
}

export interface CreateTriggerBody {
  forge: ForgeKind;
  repo: string;
  defId: string;
  labels?: string[];
  titlePattern?: string;
  vars?: Record<string, string>;
  backfill?: 'yes' | 'no';
}

export interface RequirementRow {
  id: string;
  triggerId: string;
  forge: ForgeKind;
  repo: string;
  issueNumber: string;
  title: string | null;
  author: string | null;
  issueUrl: string | null;
  runId: string | null;
  status: 'seeded' | 'started' | 'failed';
  runStatus: string | null;
  createdAt: string;
}

async function j<T>(r: Response): Promise<T> {
  if (r.status === 401) {
    window.dispatchEvent(new Event('co:unauthorized'));
    throw new Error('未登录或会话已过期');
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface LlmEndpointRow {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  createdBy: string | null;
  createdAt: string;
}

export const api = {
  machines: () => fetch('/api/machines').then((r) => j<{ machines: MachineRow[] }>(r)).then((d) => d.machines),
  sessions: () => fetch('/api/sessions').then((r) => j<{ sessions: SessionRow[] }>(r)).then((d) => d.sessions),
  events: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/events`).then((r) => j<{ events: EventRow[] }>(r)).then((d) => d.events),
  spawn: (body: { machineId: string; cwd: string; prompt?: string; model?: string; designer?: boolean }) =>
    post('/api/sessions', body).then((r) => j<{ sessionId: string }>(r)),
  workflows: () => fetch('/api/workflows').then((r) => j<{ workflows: WorkflowDefRow[] }>(r)).then((d) => d.workflows),
  createWorkflow: (graph: WorkflowDef, createdVia: 'chat' | 'manual') =>
    post('/api/workflows', { graph, createdVia }).then((r) => j<{ id: string }>(r)),
  startRun: (workflowId: string, vars: Record<string, string>) =>
    post(`/api/workflows/${workflowId}/runs`, { vars }).then((r) => j<{ runId: string }>(r)),
  runs: () => fetch('/api/runs').then((r) => j<{ runs: RunRow[] }>(r)).then((d) => d.runs),
  run: (runId: string) =>
    fetch(`/api/runs/${runId}`).then((r) => j<{ run: RunRow; def: WorkflowDefRow; nodes: NodeStateRow[] }>(r)),
  pendingApprovals: () =>
    fetch('/api/approvals?status=pending').then((r) => j<{ approvals: ApprovalRow[] }>(r)).then((d) => d.approvals),
  send: (sessionId: string, text: string) => post(`/api/sessions/${sessionId}/send`, { text }).then((r) => j(r)),
  kill: (sessionId: string) => post(`/api/sessions/${sessionId}/kill`, {}).then((r) => j(r)),
  interrupt: (sessionId: string) => post(`/api/sessions/${sessionId}/interrupt`, {}).then((r) => j(r)),
  sessionDiff: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/diff`).then((r) => j<{ ok: boolean; stat?: string; diff?: string; error?: string }>(r)),
  decide: (approvalId: string, behavior: 'allow' | 'deny', message?: string) =>
    post(`/api/approvals/${approvalId}/decide`, {
      decision: behavior === 'allow' ? { behavior } : { behavior, message },
    }).then((r) => j(r)),
  triggers: () => fetch('/api/triggers').then((r) => j<{ triggers: TriggerRow[] }>(r)).then((d) => d.triggers),
  createTrigger: (body: CreateTriggerBody) => post('/api/triggers', body).then((r) => j<{ id: string }>(r)),
  patchTrigger: (id: string, patch: Partial<Pick<TriggerRow, 'enabled' | 'backfill' | 'labels' | 'titlePattern' | 'vars'>>) =>
    fetch(`/api/triggers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  deleteTrigger: (id: string) => fetch(`/api/triggers/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  requirements: () => fetch('/api/requirements').then((r) => j<{ requirements: RequirementRow[] }>(r)).then((d) => d.requirements),
  pollTriggers: () => post('/api/triggers/poll', {}).then((r) => j<{ polled: number }>(r)),
  listEndpoints: () => fetch('/api/llm/endpoints').then((r) => j<{ endpoints: LlmEndpointRow[] }>(r)).then((d) => d.endpoints),
  upsertEndpoint: (label: string, model: string, baseUrl: string, apiKey: string) =>
    fetch(`/api/llm/endpoints/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, base_url: baseUrl, api_key: apiKey }),
    }).then((r) => j<{ ok: boolean; label: string }>(r)),
  deleteEndpoint: (label: string) =>
    fetch(`/api/llm/endpoints/${encodeURIComponent(label)}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
};
