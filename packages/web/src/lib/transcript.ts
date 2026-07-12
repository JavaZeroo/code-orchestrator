import type {
  EventRow,
  ForgeRefRow,
  NodeStateRow,
  RunThreadCursor,
  RunThreadPage,
  RunRow,
  SessionEventCursor,
  SessionEventPage,
  SessionEnvelope,
  SessionRow,
  WorkflowDefRow,
} from '../api';
import { runDisplayTitle } from './runTitle';

export type FetchSessionEventPage = (
  sessionId: string,
  cursor?: SessionEventCursor,
) => Promise<SessionEventPage>;

export type FetchRunThreadPage = (
  runId: string,
  cursor?: RunThreadCursor,
) => Promise<RunThreadPage>;

export type DownloadTranscript = (filename: string, markdown: string) => void;

export interface SessionTranscript {
  events: EventRow[];
  filename: string;
  markdown: string;
}

export interface RunTranscriptSnapshot {
  run: RunRow;
  def: WorkflowDefRow;
  nodes: NodeStateRow[];
  events: EventRow[];
  forgeRefs: ForgeRefRow[];
}

export interface RunTranscript extends RunTranscriptSnapshot {
  filename: string;
  markdown: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function sessionEnvelope(value: unknown): Partial<SessionEnvelope> | null {
  const candidate = record(value);
  return typeof candidate.ev === 'object' && candidate.ev !== null
    ? candidate as Partial<SessionEnvelope>
    : null;
}

export function orderTranscriptEvents(events: EventRow[]): EventRow[] {
  const bySequence = new Map<number, EventRow>();
  for (const event of events) {
    if (!bySequence.has(event.seq)) bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

/** Fetch a complete point-in-time snapshot by following the session API's backward cursor. */
export async function collectSessionTranscriptEvents(
  sessionId: string,
  fetchPage: FetchSessionEventPage,
): Promise<EventRow[]> {
  const events: EventRow[] = [];
  const visitedCursors = new Set<number>();
  let cursor: SessionEventCursor | undefined;

  while (true) {
    const page = await fetchPage(sessionId, cursor);
    events.push(...page.events);
    if (!page.page.hasEarlier) break;

    const before = page.page.before;
    if (before == null || !Number.isSafeInteger(before) || before <= 0 || visitedCursors.has(before)) {
      throw new Error('Session event history returned an invalid backward cursor');
    }
    visitedCursors.add(before);
    cursor = { before };
  }

  return orderTranscriptEvents(events);
}

/** Fetch a complete run snapshot, bounded by the newest event returned on the first page. */
export async function collectRunTranscriptSnapshot(
  runId: string,
  fetchPage: FetchRunThreadPage,
): Promise<RunTranscriptSnapshot> {
  const firstPage = await fetchPage(runId);
  const events = [...firstPage.events];
  const visitedCursors = new Set<number>();
  let currentPage = firstPage;

  while (currentPage.page.hasEarlier) {
    const before = currentPage.page.before;
    if (before == null || !Number.isSafeInteger(before) || before <= 0 || visitedCursors.has(before)) {
      throw new Error('Run thread history returned an invalid backward cursor');
    }
    visitedCursors.add(before);
    currentPage = await fetchPage(runId, { before });
    events.push(...currentPage.events);
  }

  return {
    run: firstPage.run,
    def: firstPage.def,
    nodes: firstPage.nodes,
    events: orderTranscriptEvents(events),
    forgeRefs: firstPage.forgeRefs,
  };
}

function sessionDisplayTitle(session: SessionRow): string {
  const title = session.title?.trim();
  if (title) return title;
  const cwdName = session.cwd.split(/[\\/]/).filter(Boolean).pop();
  return cwdName || `Session ${session.id.slice(0, 8)}`;
}

function safeFilenamePart(value: string, maxLength: number): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\.+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, maxLength)
    .replace(/[.\s-]+$/g, '');
}

export function sessionTranscriptFilename(session: SessionRow): string {
  const title = safeFilenamePart(sessionDisplayTitle(session), 80) || 'session';
  const sessionId = safeFilenamePart(session.id, 24) || 'transcript';
  return `${title}-${sessionId}.md`;
}

export function runTranscriptFilename(run: RunRow, def: WorkflowDefRow): string {
  const title = safeFilenamePart(runDisplayTitle(run, def.name), 80) || 'workflow-run';
  const runId = safeFilenamePart(run.id, 24) || 'transcript';
  return `${title}-${runId}.md`;
}

function escapeHeading(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]{}()#+.!|>])/g, '\\$1');
}

function inlineCode(value: unknown): string {
  const text = String(value).replace(/[\r\n]+/g, ' ');
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

function fencedBlock(value: string, language = ''): string {
  const longestRun = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function jsonBlock(value: unknown): string {
  try {
    return fencedBlock(JSON.stringify(value, null, 2) ?? String(value), 'json');
  } catch {
    return fencedBlock(String(value), 'text');
  }
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function heading(label: string, time?: unknown): string {
  const formattedTime = timestamp(time);
  return formattedTime ? `### ${label} · ${inlineCode(formattedTime)}` : `### ${label}`;
}

function pushSection(lines: string[], ...content: string[]) {
  lines.push(...content, '');
}

interface TranscriptEventScope {
  label: string;
  metadata?: string[];
}

function pushEventSection(
  lines: string[],
  event: EventRow,
  label: string,
  time: unknown,
  content: string[],
  scope?: TranscriptEventScope,
) {
  const scopedLabel = scope ? `${escapeHeading(scope.label)} · ${label}` : label;
  if (!scope) {
    pushSection(lines, heading(scopedLabel, time), ...content);
    return;
  }

  const audit = [
    `- **Sequence:** ${inlineCode(event.seq)}`,
    ...(event.sessionId ? [`- **Session ID:** ${inlineCode(event.sessionId)}`] : []),
    ...(scope.metadata ?? []),
  ];
  pushSection(
    lines,
    heading(scopedLabel, time),
    ...audit,
    ...(content.length > 0 ? ['', ...content] : []),
  );
}

interface ApprovalDecision {
  status: string;
  decidedBy?: string;
}

function approvalDecisions(events: EventRow[]): Map<string, ApprovalDecision> {
  const decisions = new Map<string, ApprovalDecision>();
  for (const event of events) {
    if (event.type !== 'approval.decided') continue;
    const payload = record(event.payload);
    if (typeof payload.approvalId !== 'string' || typeof payload.status !== 'string') continue;
    decisions.set(payload.approvalId, {
      status: payload.status,
      ...(typeof payload.decidedBy === 'string' ? { decidedBy: payload.decidedBy } : {}),
    });
  }
  return decisions;
}

function currentSessionState(session: SessionRow, events: EventRow[]): string {
  let state = String(session.state);
  for (const event of events) {
    if (event.type !== 'session.state') continue;
    const value = record(event.payload).state;
    if (typeof value === 'string') state = value;
  }
  return state;
}

function appendSessionMessage(
  lines: string[],
  event: EventRow,
  names: Map<string, string>,
  scope?: TranscriptEventScope,
) {
  const envelope = sessionEnvelope(event.payload);
  if (!envelope) return;
  const ev = envelope.ev;
  if (!ev) return;
  const toolKey = (call: string) => `${event.sessionId ?? ''}\u0000${call}`;

  switch (ev.t) {
    case 'text': {
      const label = ev.thinking ? 'Agent thinking' : envelope.role === 'user' ? 'User' : 'Agent';
      pushEventSection(lines, event, label, envelope.time, [ev.text || '_Empty message_'], scope);
      break;
    }
    case 'service':
      pushEventSection(lines, event, 'Service', envelope.time, [ev.text || '_Empty service message_'], scope);
      break;
    case 'tool-call-start': {
      names.set(toolKey(ev.call), ev.name);
      const details = [
        `- **Call ID:** ${inlineCode(ev.call)}`,
      ];
      if (ev.title) details.push(`- **Title:** ${ev.title.replace(/[\r\n]+/g, ' ')}`);
      if (ev.description) details.push(`- **Description:** ${ev.description.replace(/[\r\n]+/g, ' ')}`);
      details.push('', '**Arguments**', '', jsonBlock(ev.args));
      pushEventSection(lines, event, `Tool call · ${escapeHeading(ev.name)}`, envelope.time, details, scope);
      break;
    }
    case 'tool-call-end': {
      const name = names.get(toolKey(ev.call));
      const details = [
        `- **Call ID:** ${inlineCode(ev.call)}`,
        `- **Status:** ${ev.isError ? 'Failed' : 'Succeeded'}`,
      ];
      if (ev.output !== undefined) details.push('', '**Output**', '', fencedBlock(ev.output, 'text'));
      else details.push('', '_No output._');
      pushEventSection(
        lines,
        event,
        `Tool result${name ? ` · ${escapeHeading(name)}` : ''}`,
        envelope.time,
        details,
        scope,
      );
      break;
    }
    case 'file': {
      const details = [
        `- **Name:** ${inlineCode(ev.name)}`,
        `- **Reference:** ${inlineCode(ev.ref)}`,
        `- **Size:** ${ev.size} bytes`,
      ];
      if (ev.mimeType) details.push(`- **MIME type:** ${inlineCode(ev.mimeType)}`);
      pushEventSection(lines, event, 'File', envelope.time, details, scope);
      break;
    }
    case 'start':
      pushEventSection(lines, event, 'Session started', envelope.time, ev.title ? [ev.title] : [], scope);
      break;
    case 'turn-start':
      pushEventSection(lines, event, 'Turn started', envelope.time, [], scope);
      break;
    case 'turn-end':
      pushEventSection(lines, event, 'Turn ended', envelope.time, [`- **Status:** ${ev.status}`], scope);
      break;
    case 'stop':
      pushEventSection(lines, event, 'Session stopped', envelope.time, [], scope);
      break;
  }
}

function appendApproval(
  lines: string[],
  event: EventRow,
  decisions: Map<string, ApprovalDecision>,
  scope?: TranscriptEventScope,
) {
  const payload = record(event.payload);
  if (event.type === 'approval.requested') {
    if (typeof payload.id !== 'string') return;
    const decision = decisions.get(payload.id);
    const details = [
      `- **Approval ID:** ${inlineCode(payload.id)}`,
      `- **Kind:** ${inlineCode(typeof payload.kind === 'string' ? payload.kind : 'unknown')}`,
      `- **Status at export:** ${decision?.status ?? 'pending'}`,
    ];
    if (typeof payload.risk === 'string') details.push(`- **Risk:** ${inlineCode(payload.risk)}`);
    if (decision?.decidedBy) details.push(`- **Decided by:** ${inlineCode(decision.decidedBy)}`);
    details.push('', '**Details**', '', jsonBlock(payload.payload));
    pushEventSection(
      lines,
      event,
      `Approval requested${typeof payload.title === 'string' ? ` · ${escapeHeading(payload.title)}` : ''}`,
      payload.requestedAt,
      details,
      scope,
    );
    return;
  }

  if (event.type === 'approval.decided' && typeof payload.approvalId === 'string') {
    const details = [
      `- **Approval ID:** ${inlineCode(payload.approvalId)}`,
      `- **Status:** ${typeof payload.status === 'string' ? payload.status : 'unknown'}`,
    ];
    if (typeof payload.decidedBy === 'string') details.push(`- **Decided by:** ${inlineCode(payload.decidedBy)}`);
    pushEventSection(lines, event, 'Approval outcome', undefined, details, scope);
  }
}

export function formatSessionTranscript(session: SessionRow, rawEvents: EventRow[]): string {
  const events = orderTranscriptEvents(rawEvents);
  const decisions = approvalDecisions(events);
  const names = new Map<string, string>();
  const lines = [
    `# ${escapeHeading(sessionDisplayTitle(session))}`,
    '',
    '## Session metadata',
    '',
    `- **Session ID:** ${inlineCode(session.id)}`,
    `- **State:** ${inlineCode(currentSessionState(session, events))}`,
    `- **Agent:** ${inlineCode(session.agent)}`,
    `- **Model:** ${session.model ? inlineCode(session.model) : 'Not specified'}`,
    `- **Machine:** ${inlineCode(session.machineId)}`,
    `- **Working directory:** ${inlineCode(session.cwd)}`,
    `- **Created:** ${inlineCode(session.createdAt)}`,
    `- **Archived:** ${session.archivedAt ? inlineCode(session.archivedAt) : 'No'}`,
    '',
    '## Transcript',
    '',
  ];

  for (const event of events) {
    if (event.type === 'session.message') appendSessionMessage(lines, event, names);
    else if (event.type === 'approval.requested' || event.type === 'approval.decided') {
      appendApproval(lines, event, decisions);
    }
  }

  if (lines.at(-1) !== '') lines.push('');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

interface RunNodeDisplay {
  title: string;
  type?: string;
}

function interpolateNodeTitle(title: string | undefined, vars: Record<string, string>): string | undefined {
  return title?.replace(/\{\{vars\.([\w.]+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

function runNodeDisplays(snapshot: RunTranscriptSnapshot): Map<string, RunNodeDisplay> {
  const displays = new Map<string, RunNodeDisplay>();
  const vars = snapshot.run.context?.vars ?? {};
  for (const node of snapshot.def.graph.nodes) {
    displays.set(node.id, {
      title: interpolateNodeTitle(node.title, vars)?.trim() || node.id,
      type: node.type,
    });
  }
  for (const node of snapshot.nodes) {
    if (!displays.has(node.nodeId)) displays.set(node.nodeId, { title: node.nodeId });
  }
  return displays;
}

function runNodeScope(nodeId: string, displays: Map<string, RunNodeDisplay>): TranscriptEventScope {
  return {
    label: `Node · ${displays.get(nodeId)?.title ?? nodeId}`,
    metadata: [`- **Node ID:** ${inlineCode(nodeId)}`],
  };
}

function runEventScope(
  event: EventRow,
  displays: Map<string, RunNodeDisplay>,
  nodeBySession: Map<string, string>,
  nodeByApproval: Map<string, string>,
): TranscriptEventScope {
  const payload = record(event.payload);
  let nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : undefined;
  if (!nodeId && event.type === 'approval.decided' && typeof payload.approvalId === 'string') {
    nodeId = nodeByApproval.get(payload.approvalId);
  }
  if (!nodeId && event.sessionId) nodeId = nodeBySession.get(event.sessionId);
  if (nodeId) return runNodeScope(nodeId, displays);
  return event.sessionId
    ? { label: `Session · ${event.sessionId.slice(0, 8)}` }
    : { label: 'Run' };
}

function appendNodeOutcomes(
  lines: string[],
  snapshot: RunTranscriptSnapshot,
  displays: Map<string, RunNodeDisplay>,
) {
  lines.push('## Node outcomes', '');
  const states = new Map(snapshot.nodes.map((node) => [node.nodeId, node]));
  const orderedNodeIds = [
    ...snapshot.def.graph.nodes.map((node) => node.id),
    ...snapshot.nodes.map((node) => node.nodeId).filter((nodeId) => !snapshot.def.graph.nodes.some((node) => node.id === nodeId)),
  ];

  if (orderedNodeIds.length === 0) {
    lines.push('_No nodes recorded._', '');
    return;
  }

  for (const nodeId of orderedNodeIds) {
    const display = displays.get(nodeId) ?? { title: nodeId };
    const state = states.get(nodeId);
    const details = [
      `### ${escapeHeading(display.title)}`,
      '',
      `- **Node ID:** ${inlineCode(nodeId)}`,
      `- **Type:** ${display.type ? inlineCode(display.type) : 'Not specified'}`,
      `- **Status:** ${state ? inlineCode(state.status) : 'Not recorded'}`,
      `- **Session ID:** ${state?.sessionId ? inlineCode(state.sessionId) : 'None'}`,
      `- **Model:** ${state?.model ? inlineCode(state.model) : 'Not specified'}`,
      `- **Updated:** ${state ? inlineCode(state.updatedAt) : 'Not recorded'}`,
      '',
      '**Output**',
      '',
      state?.output ? jsonBlock(state.output) : '_No output recorded._',
      '',
    ];
    lines.push(...details);
  }
}

function forgeReferenceUrl(ref: ForgeRefRow): string {
  if (ref.forge === 'github') {
    return ref.kind === 'pr'
      ? `https://github.com/${ref.repo}/pull/${ref.number}`
      : `https://github.com/${ref.repo}/issues/${ref.number}`;
  }
  return ref.kind === 'pr'
    ? `https://gitcode.com/${ref.repo}/merge_requests/${ref.number}`
    : `https://gitcode.com/${ref.repo}/issues/${ref.number}`;
}

function appendForgeReferences(
  lines: string[],
  forgeRefs: ForgeRefRow[],
  displays: Map<string, RunNodeDisplay>,
) {
  lines.push('## Forge references', '');
  if (forgeRefs.length === 0) {
    lines.push('_No forge references recorded._', '');
    return;
  }

  const sorted = [...forgeRefs].sort((left, right) =>
    `${left.forge}:${left.repo}:${left.number}`.localeCompare(`${right.forge}:${right.repo}:${right.number}`));
  for (const ref of sorted) {
    const label = ref.kind === 'pr' ? 'Pull request' : 'Issue';
    const nodeTitle = ref.nodeId ? displays.get(ref.nodeId)?.title : undefined;
    lines.push(
      `### ${label} · ${escapeHeading(ref.forge)} ${escapeHeading(ref.repo)}#${ref.number}`,
      '',
      `- **Reference ID:** ${inlineCode(ref.id)}`,
      `- **URL:** ${inlineCode(forgeReferenceUrl(ref))}`,
      `- **Node:** ${ref.nodeId ? `${nodeTitle ? `${inlineCode(nodeTitle)} · ` : ''}${inlineCode(ref.nodeId)}` : 'None'}`,
      `- **Session ID:** ${ref.sessionId ? inlineCode(ref.sessionId) : 'None'}`,
      `- **CI status:** ${ref.ciStatus ? inlineCode(ref.ciStatus) : 'Not reported'}`,
      `- **Active:** ${inlineCode(ref.active)}`,
      '',
      '**Snapshot**',
      '',
      ref.snapshot ? jsonBlock(ref.snapshot) : '_No snapshot recorded._',
      '',
    );
  }
}

function appendRunTimelineEvent(
  lines: string[],
  event: EventRow,
  scope: TranscriptEventScope,
) {
  const payload = record(event.payload);
  let label: string;
  const details: string[] = [];

  switch (event.type) {
    case 'run.started':
      label = 'Run started';
      break;
    case 'run.finished':
      label = 'Run finished';
      break;
    case 'run.status':
      label = 'Run status changed';
      break;
    case 'run.node.state':
      label = 'Node state changed';
      if (typeof payload.status === 'string') details.push(`- **Status:** ${inlineCode(payload.status)}`);
      break;
    case 'run.node.retry':
      label = 'Node retry';
      break;
    case 'run.node.revise':
      label = 'Node revision';
      break;
    case 'run.check':
      label = 'Node check';
      break;
    case 'meeting.concluded':
      label = 'Meeting concluded';
      break;
    case 'forge.ref_registered':
      label = 'Forge reference registered';
      break;
    case 'forge.pr_state':
      label = 'Forge pull request state changed';
      break;
    case 'forge.ci':
      label = 'Forge CI state changed';
      break;
    case 'forge.conflict':
      label = 'Forge conflict detected';
      break;
    case 'forge.review_comment':
      label = 'Forge review comment';
      break;
    case 'session.state':
      label = 'Session state changed';
      break;
    default:
      label = `Event · ${escapeHeading(event.type)}`;
  }

  if (details.length > 0) details.push('');
  details.push('**Payload**', '', jsonBlock(event.payload));
  pushEventSection(lines, event, label, undefined, details, scope);
}

export function formatRunTranscript(snapshot: RunTranscriptSnapshot): string {
  const events = orderTranscriptEvents(snapshot.events);
  const normalized = { ...snapshot, events };
  const displays = runNodeDisplays(normalized);
  const nodeBySession = new Map<string, string>();
  const nodeByApproval = new Map<string, string>();

  for (const node of normalized.nodes) {
    if (node.sessionId) nodeBySession.set(node.sessionId, node.nodeId);
  }
  for (const ref of normalized.forgeRefs) {
    if (ref.sessionId && ref.nodeId) nodeBySession.set(ref.sessionId, ref.nodeId);
  }
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === 'run.node.state'
      && typeof payload.nodeId === 'string'
      && typeof payload.sessionId === 'string') {
      nodeBySession.set(payload.sessionId, payload.nodeId);
    }
    if (event.type === 'approval.requested'
      && typeof payload.id === 'string'
      && typeof payload.nodeId === 'string') {
      nodeByApproval.set(payload.id, payload.nodeId);
    }
  }

  const decisions = approvalDecisions(events);
  const names = new Map<string, string>();
  const lines = [
    `# ${escapeHeading(runDisplayTitle(normalized.run, normalized.def.name))}`,
    '',
    '## Run metadata',
    '',
    `- **Run ID:** ${inlineCode(normalized.run.id)}`,
    `- **Status:** ${inlineCode(normalized.run.status)}`,
    `- **Workflow:** ${inlineCode(normalized.def.name)}`,
    `- **Workflow ID:** ${inlineCode(normalized.def.id)}`,
    `- **Workflow version:** ${inlineCode(normalized.def.version)}`,
    `- **Project ID:** ${normalized.run.projectId ? inlineCode(normalized.run.projectId) : 'None'}`,
    `- **Started:** ${inlineCode(normalized.run.startedAt)}`,
    `- **Ended:** ${normalized.run.endedAt ? inlineCode(normalized.run.endedAt) : 'Not ended'}`,
    `- **Archived:** ${normalized.run.archivedAt ? inlineCode(normalized.run.archivedAt) : 'No'}`,
    '',
    '### Variables',
    '',
    jsonBlock(normalized.run.context?.vars ?? {}),
    '',
    '### Outputs',
    '',
    jsonBlock(normalized.run.context?.outputs ?? {}),
    '',
  ];

  appendNodeOutcomes(lines, normalized, displays);
  appendForgeReferences(lines, normalized.forgeRefs, displays);
  lines.push('## Timeline', '');

  if (events.length === 0) {
    lines.push('_No timeline events recorded._', '');
  } else {
    for (const event of events) {
      const scope = runEventScope(event, displays, nodeBySession, nodeByApproval);
      if (event.type === 'session.message') appendSessionMessage(lines, event, names, scope);
      else if (event.type === 'approval.requested' || event.type === 'approval.decided') {
        appendApproval(lines, event, decisions, scope);
      } else {
        appendRunTimelineEvent(lines, event, scope);
      }
    }
  }

  if (lines.at(-1) !== '') lines.push('');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function downloadSessionTranscript(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function exportSessionTranscript(
  session: SessionRow,
  fetchPage: FetchSessionEventPage,
  download: DownloadTranscript = downloadSessionTranscript,
): Promise<SessionTranscript> {
  const events = await collectSessionTranscriptEvents(session.id, fetchPage);
  const transcript = {
    events,
    filename: sessionTranscriptFilename(session),
    markdown: formatSessionTranscript(session, events),
  };
  download(transcript.filename, transcript.markdown);
  return transcript;
}

export async function exportRunTranscript(
  runId: string,
  fetchPage: FetchRunThreadPage,
  download: DownloadTranscript = downloadSessionTranscript,
): Promise<RunTranscript> {
  const snapshot = await collectRunTranscriptSnapshot(runId, fetchPage);
  const transcript = {
    ...snapshot,
    filename: runTranscriptFilename(snapshot.run, snapshot.def),
    markdown: formatRunTranscript(snapshot),
  };
  download(transcript.filename, transcript.markdown);
  return transcript;
}
