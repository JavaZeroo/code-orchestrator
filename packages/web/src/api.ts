import type { ApprovalRequest, RunNoteDeletionPayload, RunNotePayload, RunNoteRevisionPayload, SessionAgent, SessionEnvelope, SessionNoteDeletionPayload, SessionNotePayload, SessionNoteRevisionPayload, SessionState, WorkflowDef } from '@co/protocol';

export interface EventRow {
  seq: number;
  type: string;
  sessionId?: string | null;
  runId?: string | null;
  payload: unknown;
}

export interface RunNoteEventRow extends EventRow {
  type: 'run.note';
  runId: string;
  payload: RunNotePayload;
}

export interface SessionNoteEventRow extends EventRow {
  type: 'session.note';
  sessionId: string;
  payload: SessionNotePayload;
}

export interface RunNoteRevisionEventRow extends EventRow {
  type: 'run.note.updated';
  runId: string;
  payload: RunNoteRevisionPayload;
}

export interface SessionNoteRevisionEventRow extends EventRow {
  type: 'session.note.updated';
  sessionId: string;
  payload: SessionNoteRevisionPayload;
}

export interface RunNoteDeletionEventRow extends EventRow {
  type: 'run.note.deleted';
  runId: string;
  payload: RunNoteDeletionPayload;
}

export interface SessionNoteDeletionEventRow extends EventRow {
  type: 'session.note.deleted';
  sessionId: string;
  payload: SessionNoteDeletionPayload;
}

export interface SessionEventPage {
  events: EventRow[];
  page: {
    hasEarlier: boolean;
    before: number | null;
  };
}

export type SessionEventCursor =
  | { before: number; since?: never }
  | { before?: never; since: number };

export type RunThreadCursor = SessionEventCursor;

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
  title: string | null;
  state: SessionState | string;
  nativeSessionId: string | null;
  runId: string | null;
  nodeId: string | null;
  projectId: string | null;
  containerId: string | null;
  usage: SessionUsage | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface WorkspaceEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

export interface WorkspaceContentMatch {
  path: string;
  line: number;
  preview: string;
}

export interface WorkspaceContentSearchResult {
  matches: WorkspaceContentMatch[];
  truncated: boolean;
}

export const WORKSPACE_TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
export const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type WorkspaceImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const WORKSPACE_IMAGE_MIME_TYPES: Record<string, WorkspaceImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export type WorkspaceTextPreview =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'oversized' };

export type WorkspaceImagePreview =
  | { kind: 'image'; blob: Blob }
  | { kind: 'oversized' };

export function workspaceImageMimeType(name: string): WorkspaceImageMimeType | null {
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension ? WORKSPACE_IMAGE_MIME_TYPES[extension] ?? null : null;
}

export function isWorkspaceImagePreviewCandidate(entry: WorkspaceEntry): boolean {
  return entry.type === 'file'
    && entry.size !== undefined
    && entry.size <= WORKSPACE_IMAGE_PREVIEW_MAX_BYTES
    && workspaceImageMimeType(entry.name) !== null;
}

export function isWorkspaceTextPreviewCandidate(entry: WorkspaceEntry): boolean {
  if (entry.type !== 'file' || entry.size === undefined || entry.size > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) return false;
  const name = entry.name.toLowerCase();
  if (['dockerfile', 'makefile', 'license', 'readme'].includes(name)) return true;
  return /\.(?:txt|md|markdown|json|jsonl|ya?ml|toml|xml|csv|tsv|log|diff|patch|tsx?|jsx?|mjs|cjs|css|scss|html?|sh|bash|zsh|py|rb|go|rs|java|c|h|cpp|hpp|cs|sql|env|ini|cfg|conf)$/.test(name);
}

export async function decodeWorkspaceTextPreview(response: Response): Promise<WorkspaceTextPreview> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) return { kind: 'oversized' };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) return { kind: 'oversized' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'binary' };
  }
  let controls = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 0) return { kind: 'binary' };
    if (code < 32 && char !== '\n' && char !== '\r' && char !== '\t') controls += 1;
  }
  if (text.length > 0 && controls / text.length > 0.01) return { kind: 'binary' };
  return { kind: 'text', text };
}

export async function decodeWorkspaceImagePreview(
  response: Response,
  mimeType: WorkspaceImageMimeType,
): Promise<WorkspaceImagePreview> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) return { kind: 'oversized' };
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) return { kind: 'oversized' };
  return { kind: 'image', blob: new Blob([bytes], { type: mimeType }) };
}

export interface MachineRow {
  id: string;
  name: string;
  labels: string[];
  codeServerUrl?: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface MaterializationRow { machineId: string; basePath: string; status: 'materializing' | 'ready' | 'failed'; }

export interface QueuedSessionRow {
  id: string;
  projectId: string;
  kind: string | null;
  priority: number;
  status: 'pending' | 'failed';
  enqueuedAt: string;
  prompt: string | null;
  agent: string | null;
  model: string | null;
}

export interface AllMachineRow {
  id: string;
  name: string;
  labels: string[];
  status: 'online' | 'offline';
  schedulingPaused: boolean;
  lastActiveAt: string | null;
  dataRoot: string | null;
  resources: Array<{ kind: string; index: number; model?: string }>;
  enrollToken: string | null;
  componentCache: Record<string, string[]>;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
}

export interface ComponentSourceRow {
  id: string;
  component: string;
  version: string;
  url: string;
  sha256: string | null;
  createdAt: string;
}

export type { ApprovalRequest, RunNotePayload, SessionEnvelope, SessionNotePayload, SessionState, WorkflowDef };
export type { SessionAgent };

export interface WorkflowDefRow {
  id: string;
  name: string;
  version: number;
  graph: WorkflowDef;
  createdVia: string;
  projectId: string | null;
  archived: string; // 'yes' | 'no'
  createdAt: string;
}

export interface RunRow {
  id: string;
  defId: string;
  /** server 已返回（leftJoin workflow_defs），前端补上类型 */
  defName?: string | null;
  projectId: string | null;
  title: string | null;
  status: string;
  context: { vars: Record<string, string>; outputs: Record<string, string> };
  startedAt: string;
  endedAt: string | null;
  archivedAt: string | null;
}

export interface RunRetryResult {
  ok: true;
  run: Pick<RunRow, 'id' | 'status' | 'endedAt'>;
  retriedNodeIds: string[];
}

export interface RunProgressionResult {
  ok: true;
  run: Pick<RunRow, 'id' | 'status'>;
}

export interface NodeStateRow {
  runId: string;
  nodeId: string;
  status: string;
  sessionId: string | null;
  output: { summary?: string; error?: string; verdict?: string; minutes?: string } | null;
  /** 该节点执行时使用的模型（来自 sessions 表） */
  model?: string | null;
  updatedAt: string;
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

export type UserInputAnswers = Record<string, { answers: string[] }>;

export type ForgeKind = 'gitcode' | 'github';

export interface ForgeRefRow {
  id: string;
  forge: ForgeKind;
  kind: 'pr' | 'issue';
  repo: string;
  number: number;
  runId: string | null;
  nodeId: string | null;
  sessionId: string | null;
  ciStatus: string | null;
  snapshot: Record<string, unknown> | null;
  active: 'yes' | 'no';
}

export interface RunThreadPage {
  run: RunRow;
  def: WorkflowDefRow;
  nodes: NodeStateRow[];
  events: EventRow[];
  forgeRefs: ForgeRefRow[];
  page: {
    hasEarlier: boolean;
    before: number | null;
  };
}

export interface TriggerRow {
  id: string;
  projectId: string | null;
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
  /** 归属项目（详情页创建时必带；服务端 createSchema 已支持，无需改 server） */
  projectId?: string;
  forge: ForgeKind;
  repo: string;
  defId: string;
  labels?: string[];
  titlePattern?: string;
  vars?: Record<string, string>;
  backfill?: 'yes' | 'no';
  kind?: 'issue' | 'schedule';
  schedule?: string;
}

export interface RequirementRow {
  id: string;
  triggerId: string;
  projectId: string | null;
  forge: ForgeKind;
  repo: string;
  issueNumber: string;
  title: string | null;
  author: string | null;
  issueUrl: string | null;
  runId: string | null;
  status: 'seeded' | 'starting' | 'started' | 'failed';
  runStatus: string | null;
  createdAt: string;
}

export type Autonomy = 'manual' | 'agent' | 'auto';
export interface ProjectRow {
  id: string;
  name: string;
  forge: ForgeKind;
  repo: string;
  autonomy: Autonomy;
  guardrails: string[];
  defaultDefId: string | null;
  /** 默认流程定义（任务受理器预选此模板） */
  defaultWorkflow: string | null;
  models: Record<string, string>;
  vars: Record<string, string>;
  /** design-v2 容器化：薄 base 镜像（空=非容器化项目） */
  baseImage: string | null;
  /** 加速器需求 {kind} 或 null（非空=会话独占该 kind 机器并绑卡） */
  accel: { kind: string } | null;
  /** 组件默认版本 {组件:版本} */
  components: Record<string, string>;
  memoryRepo: string | null;
  createdAt: string;
}

export interface WorkItem {
  id: string;
  key: string;
  type: string;
  parentId: string | null;
  title: string | null;
  status: string;
  owner: string | null;
  refs: Record<string, unknown>;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  children: WorkItem[];
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

async function ok(r: Response): Promise<Response> {
  if (r.status === 401) {
    window.dispatchEvent(new Event('co:unauthorized'));
    throw new Error('未登录或会话已过期');
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${body.slice(0, 300)}`);
  }
  return r;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface LlmProviderRow {
  id: string;
  name: string;
  baseUrl: string | null;
  models: string[];
  defaultModel: string | null;
  hasKey: boolean;
  builtin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  machines: () => fetch('/api/machines').then((r) => j<{ machines: MachineRow[] }>(r)).then((d) => d.machines),
  allMachines: () => fetch('/api/machines/all').then((r) => j<{ machines: AllMachineRow[] }>(r)).then((d) => d.machines),
  sessions: () => fetch('/api/sessions').then((r) => j<{ sessions: SessionRow[] }>(r)).then((d) => d.sessions),
  session: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`).then((r) => j<{ session: SessionRow }>(r)).then((d) => d.session),
  archivedSessions: () => fetch('/api/sessions?archived=true').then((r) => j<{ sessions: SessionRow[] }>(r)).then((d) => d.sessions),
  renameSession: (sessionId: string, title: string) =>
    fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => j<{ ok: true; session: Pick<SessionRow, 'id' | 'title'> }>(r)),
  events: (sessionId: string, cursor?: SessionEventCursor) => {
    const query = new URLSearchParams();
    if (cursor?.before) query.set('before', String(cursor.before));
    if (cursor?.since) query.set('since', String(cursor.since));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return fetch(`/api/sessions/${sessionId}/events${suffix}`).then((r) => j<SessionEventPage>(r));
  },
  addSessionNote: (sessionId: string, markdown: string) =>
    post(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, { markdown })
      .then((r) => j<{ note: SessionNoteEventRow }>(r)),
  editSessionNote: (sessionId: string, noteId: number, markdown: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes/${noteId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown }),
    }).then((r) => j<{ note: SessionNoteRevisionEventRow }>(r)),
  deleteSessionNote: (sessionId: string, noteId: number) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes/${noteId}`, { method: 'DELETE' })
      .then((r) => j<{ note: SessionNoteDeletionEventRow }>(r)),
  spawn: (body: { projectId?: string | null; prompt?: string; agent?: SessionAgent; model?: string; effort?: Effort;
                  machineId?: string; cwd?: string; container?: boolean;
                  designer?: boolean; taskIntake?: boolean }) =>
    post('/api/sessions', body).then((r) =>
      j<{ sessionId?: string; resolved?: { machineId: string; cwd: string }; queued?: boolean; taskId?: string }>(r)),
  workflows: () => fetch('/api/workflows').then((r) => j<{ workflows: WorkflowDefRow[] }>(r)).then((d) => d.workflows),
  createWorkflow: (graph: WorkflowDef, createdVia: 'chat' | 'manual', projectId?: string | null) =>
    post('/api/workflows', { graph, createdVia, projectId }).then((r) => j<{ id: string }>(r)),
  reviseWorkflow: (id: string, graph: WorkflowDef, createdVia: 'chat' | 'manual') =>
    post(`/api/workflows/${encodeURIComponent(id)}/revisions`, { graph, createdVia })
      .then((r) => j<{ id: string; name: string; version: number; previousId: string }>(r)),
  patchWorkflow: (id: string, patch: { archived?: 'yes' | 'no'; name?: string }) =>
    fetch(`/api/workflows/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  startRun: (workflowId: string, vars: Record<string, string>, projectId?: string | null) =>
    post(`/api/workflows/${workflowId}/runs`, { vars, projectId }).then((r) => j<{ runId: string }>(r)),
  runs: () => fetch('/api/runs').then((r) => j<{ runs: RunRow[] }>(r)).then((d) => d.runs),
  archivedRuns: () => fetch('/api/runs?archived=true').then((r) => j<{ runs: RunRow[] }>(r)).then((d) => d.runs),
  run: (runId: string) =>
    fetch(`/api/runs/${runId}`).then((r) => j<{ run: RunRow; def: WorkflowDefRow; nodes: NodeStateRow[] }>(r)),
  renameRun: (runId: string, title: string) =>
    fetch(`/api/runs/${runId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => j<{ ok: true; run: Pick<RunRow, 'id' | 'title'> }>(r)),
  addRunNote: (runId: string, markdown: string) =>
    post(`/api/runs/${encodeURIComponent(runId)}/notes`, { markdown })
      .then((r) => j<{ note: RunNoteEventRow }>(r)),
  editRunNote: (runId: string, noteId: number, markdown: string) =>
    fetch(`/api/runs/${encodeURIComponent(runId)}/notes/${noteId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown }),
    }).then((r) => j<{ note: RunNoteRevisionEventRow }>(r)),
  deleteRunNote: (runId: string, noteId: number) =>
    fetch(`/api/runs/${encodeURIComponent(runId)}/notes/${noteId}`, { method: 'DELETE' })
      .then((r) => j<{ note: RunNoteDeletionEventRow }>(r)),
  cancelRun: (runId: string) => post(`/api/runs/${runId}/cancel`, {}).then((r) => j<{ ok: boolean }>(r)),
  pauseRun: (runId: string) => post(`/api/runs/${runId}/pause`, {}).then((r) => j<RunProgressionResult>(r)),
  resumeRun: (runId: string) => post(`/api/runs/${runId}/resume`, {}).then((r) => j<RunProgressionResult>(r)),
  retryRun: (runId: string) => post(`/api/runs/${runId}/retry`, {}).then((r) => j<RunRetryResult>(r)),
  archiveRun: (runId: string) =>
    post(`/api/runs/${runId}/archive`, {}).then((r) =>
      j<{ ok: true; run: Pick<RunRow, 'id' | 'archivedAt'> }>(r)),
  restoreRun: (runId: string) =>
    post(`/api/runs/${runId}/restore`, {}).then((r) =>
      j<{ ok: true; run: Pick<RunRow, 'id' | 'archivedAt'> }>(r)),
  runThread: (runId: string, cursor?: RunThreadCursor) => {
    const query = new URLSearchParams();
    if (cursor?.before) query.set('before', String(cursor.before));
    if (cursor?.since) query.set('since', String(cursor.since));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return fetch(`/api/runs/${runId}/thread${suffix}`).then((r) => j<RunThreadPage>(r));
  },
  retestForgeRef: (refId: string) =>
    fetch(`/api/forge/refs/${encodeURIComponent(refId)}/retest`, { method: 'POST' })
      .then((r) => j<{ ok: true; confirmation: 'pending' }>(r)),
  commentForgeRef: (refId: string, body: string) =>
    post(`/api/forge/refs/${encodeURIComponent(refId)}/comments`, { body })
      .then((r) => j<{ ok: true; commentId: number }>(r)),
  pendingApprovals: () =>
    fetch('/api/approvals?status=pending').then((r) => j<{ approvals: ApprovalRow[] }>(r)).then((d) => d.approvals),
  send: (sessionId: string, text: string) => post(`/api/sessions/${sessionId}/send`, { text }).then((r) => j(r)),
  resume: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/resume`, {}).then((r) => j<{ ok: true; sessionId: string }>(r)),
  fork: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/fork`, {}).then((r) => j<{ ok: true; sessionId: string }>(r)),
  archiveSession: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/archive`, {}).then((r) =>
      j<{ ok: true; session: Pick<SessionRow, 'id' | 'archivedAt'> }>(r)),
  restoreSession: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/restore`, {}).then((r) =>
      j<{ ok: true; session: Pick<SessionRow, 'id' | 'archivedAt'> }>(r)),
  kill: (sessionId: string) => post(`/api/sessions/${sessionId}/kill`, {}).then((r) => j(r)),
  interrupt: (sessionId: string) => post(`/api/sessions/${sessionId}/interrupt`, {}).then((r) => j(r)),
  sessionDiff: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/diff`).then((r) => j<{ ok: boolean; stat?: string; diff?: string; error?: string }>(r)),
  workspaceFile: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`).then(ok),
  workspaceArchive: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/archive?path=${encodeURIComponent(path)}`).then(ok),
  workspaceTextPreview: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`)
      .then(ok)
      .then(decodeWorkspaceTextPreview),
  workspaceImagePreview: (sessionId: string, path: string) => {
    const mimeType = workspaceImageMimeType(path);
    if (!mimeType) return Promise.reject(new Error('unsupported workspace image type'));
    return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`)
      .then(ok)
      .then((response) => decodeWorkspaceImagePreview(response, mimeType));
  },
  workspaceFiles: (sessionId: string, path = '') =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/list?path=${encodeURIComponent(path)}`)
      .then((r) => j<WorkspaceListing>(r)),
  searchWorkspaceFiles: (sessionId: string, query: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/search?q=${encodeURIComponent(query)}`)
      .then((r) => j<WorkspaceSearchResult>(r)),
  searchWorkspaceContent: (sessionId: string, query: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/search-content?q=${encodeURIComponent(query)}`)
      .then((r) => j<WorkspaceContentSearchResult>(r)),
  uploadWorkspaceFile: (sessionId: string, path: string, file: Blob) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }).then((r) => j<{ ok: true; path: string; size: number }>(r)),
  deleteWorkspaceFile: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }).then((r) => j<{ ok: true; path: string }>(r)),
  createWorkspaceDirectory: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/directories?path=${encodeURIComponent(path)}`, {
      method: 'POST',
    }).then((r) => j<{ ok: true; path: string }>(r)),
  renameWorkspaceEntry: (sessionId: string, path: string, name: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => j<{ ok: true; path: string }>(r)),
  moveWorkspaceEntry: (sessionId: string, path: string, destinationPath: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/move?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationPath }),
    }).then((r) => j<{ ok: true; path: string }>(r)),
  copyWorkspaceEntry: (sessionId: string, path: string, destinationPath: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/copy?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationPath }),
    }).then((r) => j<{ ok: true; path: string }>(r)),
  decide: (approvalId: string, behavior: 'allow' | 'deny', message?: string) =>
    post(`/api/approvals/${approvalId}/decide`, {
      decision: behavior === 'allow' ? { behavior } : { behavior, message },
    }).then((r) => j(r)),
  answer: (approvalId: string, answers: UserInputAnswers) =>
    post(`/api/approvals/${approvalId}/decide`, {
      decision: { behavior: 'allow', updatedInput: { answers } },
    }).then((r) => j(r)),
  triggers: () => fetch('/api/triggers').then((r) => j<{ triggers: TriggerRow[] }>(r)).then((d) => d.triggers),
  createTrigger: (body: CreateTriggerBody) => post('/api/triggers', body).then((r) => j<{ id: string }>(r)),
  patchTrigger: (id: string, patch: Partial<Pick<TriggerRow, 'enabled' | 'backfill' | 'labels' | 'titlePattern' | 'vars'>>) =>
    fetch(`/api/triggers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  deleteTrigger: (id: string) => fetch(`/api/triggers/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  requirements: () => fetch('/api/requirements').then((r) => j<{ requirements: RequirementRow[] }>(r)).then((d) => d.requirements),
  startRequirement: (id: string) =>
    fetch(`/api/requirements/${encodeURIComponent(id)}/start`, { method: 'POST' })
      .then((r) => j<{ runId: string }>(r)),
  pollTriggers: () => post('/api/triggers/poll', {}).then((r) => j<{ polled: number }>(r)),
  listProviders: () => fetch('/api/llm/providers').then((r) => j<{ providers: LlmProviderRow[] }>(r)).then((d) => d.providers),
  saveProvider: (name: string, body: { base_url?: string | null; api_key?: string; models?: string[]; default_model?: string | null }) =>
    fetch(`/api/llm/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: boolean; name: string }>(r)),
  deleteProvider: (name: string) =>
    fetch(`/api/llm/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  projects: () => fetch('/api/projects').then((r) => j<{ projects: ProjectRow[] }>(r)).then((d) => d.projects),
  createProject: (body: Partial<ProjectRow>) => post('/api/projects', body).then((r) => j<{ id: string }>(r)),
  componentSources: () =>
    fetch('/api/component-sources').then((r) => j<{ sources: ComponentSourceRow[] }>(r)).then((d) => d.sources),
  createComponentSource: (body: { component: string; version: string; url: string; sha256?: string }) =>
    post('/api/component-sources', body).then((r) => j<{ id: string }>(r)),
  deleteComponentSource: (id: string) =>
    fetch(`/api/component-sources/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  dispatchComponent: (id: string, machineId: string) =>
    post(`/api/component-sources/${id}/dispatch`, { machineId }).then((r) => j<{ ok: boolean; note?: string }>(r)),
  sshKey: () => fetch('/api/ssh-key').then((r) => j<{ publicKey: string }>(r)),
  rotateSshKey: () => post('/api/ssh-key/rotate', {}).then((r) => j<{ publicSsh: string }>(r)),
  sshTest: (id: string, password?: string) =>
    post(`/api/machines/${id}/ssh-test`, password ? { password } : {}).then((r) => j<{ ok: boolean; uname?: string; keyInstalled?: boolean }>(r)),
  runnerInstall: (id: string, dataRoot?: string) =>
    post(`/api/machines/${id}/runner-install`, dataRoot ? { dataRoot } : {}).then((r) => j<{ ok: boolean }>(r)),
  runnerRestart: (id: string) => post(`/api/machines/${id}/runner-restart`, {}).then((r) => j<{ ok: boolean; via?: string }>(r)),
  createMachine: (body: { name: string; labels: string[] }) =>
    post('/api/machines', body).then((r) => j<{ id: string; enrollToken: string }>(r)),
  patchMachine: (id: string, patch: { name?: string; labels?: string[]; schedulingPaused?: boolean; sshHost?: string | null; sshPort?: number | null; sshUser?: string | null }) =>
    fetch(`/api/machines/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  deleteMachine: (id: string) => fetch(`/api/machines/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  regenMachineToken: (id: string) => post(`/api/machines/${id}/token`, {}).then((r) => j<{ enrollToken: string }>(r)),
  resources: () =>
    fetch('/api/resources').then((r) =>
      j<{ machines: { id: string; labels: string[]; accels: { kind: string; total: number }[]; used: number }[]; queued: number }>(r)),
  queuedSessions: (projectId: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/queued-sessions`)
      .then((r) => j<{ tasks: QueuedSessionRow[] }>(r)).then((d) => d.tasks),
  reprioritizeQueuedSession: (projectId: string, taskId: string, priority: number) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/queued-sessions/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority }),
    }).then((r) => j<{ ok: boolean; priority: number }>(r)),
  retryQueuedSession: (projectId: string, taskId: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/queued-sessions/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
    }).then((r) => j<{ ok: boolean }>(r)),
  cancelQueuedSession: (projectId: string, taskId: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/queued-sessions/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
      .then((r) => j<{ ok: boolean }>(r)),
  dispatchPipeline: (projectId: string, body: { text: string; defId?: string }) =>
    post(`/api/projects/${projectId}/dispatch`, body).then((r) =>
      j<{ runId: string; issueNumber: string; issueUrl?: string }>(r)),
  patchProject: (id: string, patch: Partial<ProjectRow>) =>
    fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  deleteProject: (id: string) => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  projectMaterializations: (projectId: string) =>
    fetch(`/api/projects/${projectId}/materializations`).then((r) => j<{ materializations: MaterializationRow[] }>(r)).then((d) => d.materializations),
  /** 容器化会话（design-v2 #37）：项目须配 baseImage；无空闲机返回 {queued} */
  createContainerSession: (body: { projectId: string; prompt?: string; agent?: SessionAgent; model?: string; machineId?: string; effort?: Effort }) =>
    post('/api/container-sessions', body).then((r) => j<{ sessionId?: string; queued?: boolean; taskId?: string }>(r)),
  work: (projectId?: string | null) =>
    fetch(`/api/work?limit=400${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`)
      .then((r) => j<{ tree: WorkItem[]; count: number }>(r)),
};
