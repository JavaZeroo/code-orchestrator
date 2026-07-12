import type {
  EventRow,
  SessionEventCursor,
  SessionEventPage,
  SessionEnvelope,
  SessionRow,
} from '../api';

export type FetchSessionEventPage = (
  sessionId: string,
  cursor?: SessionEventCursor,
) => Promise<SessionEventPage>;

export type DownloadTranscript = (filename: string, markdown: string) => void;

export interface SessionTranscript {
  events: EventRow[];
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

function appendSessionMessage(lines: string[], event: EventRow, names: Map<string, string>) {
  const envelope = sessionEnvelope(event.payload);
  if (!envelope) return;
  const ev = envelope.ev;
  if (!ev) return;

  switch (ev.t) {
    case 'text': {
      const label = ev.thinking ? 'Agent thinking' : envelope.role === 'user' ? 'User' : 'Agent';
      pushSection(lines, heading(label, envelope.time), ev.text || '_Empty message_');
      break;
    }
    case 'service':
      pushSection(lines, heading('Service', envelope.time), ev.text || '_Empty service message_');
      break;
    case 'tool-call-start': {
      names.set(ev.call, ev.name);
      const details = [
        heading(`Tool call · ${escapeHeading(ev.name)}`, envelope.time),
        `- **Call ID:** ${inlineCode(ev.call)}`,
      ];
      if (ev.title) details.push(`- **Title:** ${ev.title.replace(/[\r\n]+/g, ' ')}`);
      if (ev.description) details.push(`- **Description:** ${ev.description.replace(/[\r\n]+/g, ' ')}`);
      details.push('', '**Arguments**', '', jsonBlock(ev.args));
      pushSection(lines, ...details);
      break;
    }
    case 'tool-call-end': {
      const name = names.get(ev.call);
      const details = [
        heading(`Tool result${name ? ` · ${escapeHeading(name)}` : ''}`, envelope.time),
        `- **Call ID:** ${inlineCode(ev.call)}`,
        `- **Status:** ${ev.isError ? 'Failed' : 'Succeeded'}`,
      ];
      if (ev.output !== undefined) details.push('', '**Output**', '', fencedBlock(ev.output, 'text'));
      else details.push('', '_No output._');
      pushSection(lines, ...details);
      break;
    }
    case 'file': {
      const details = [
        heading('File', envelope.time),
        `- **Name:** ${inlineCode(ev.name)}`,
        `- **Reference:** ${inlineCode(ev.ref)}`,
        `- **Size:** ${ev.size} bytes`,
      ];
      if (ev.mimeType) details.push(`- **MIME type:** ${inlineCode(ev.mimeType)}`);
      pushSection(lines, ...details);
      break;
    }
    case 'start':
      pushSection(lines, heading('Session started', envelope.time), ...(ev.title ? [ev.title] : []));
      break;
    case 'turn-start':
      pushSection(lines, heading('Turn started', envelope.time));
      break;
    case 'turn-end':
      pushSection(lines, heading('Turn ended', envelope.time), `- **Status:** ${ev.status}`);
      break;
    case 'stop':
      pushSection(lines, heading('Session stopped', envelope.time));
      break;
  }
}

function appendApproval(
  lines: string[],
  event: EventRow,
  decisions: Map<string, ApprovalDecision>,
) {
  const payload = record(event.payload);
  if (event.type === 'approval.requested') {
    if (typeof payload.id !== 'string') return;
    const decision = decisions.get(payload.id);
    const details = [
      heading(`Approval requested${typeof payload.title === 'string' ? ` · ${escapeHeading(payload.title)}` : ''}`, payload.requestedAt),
      `- **Approval ID:** ${inlineCode(payload.id)}`,
      `- **Kind:** ${inlineCode(typeof payload.kind === 'string' ? payload.kind : 'unknown')}`,
      `- **Status at export:** ${decision?.status ?? 'pending'}`,
    ];
    if (typeof payload.risk === 'string') details.push(`- **Risk:** ${inlineCode(payload.risk)}`);
    if (decision?.decidedBy) details.push(`- **Decided by:** ${inlineCode(decision.decidedBy)}`);
    details.push('', '**Details**', '', jsonBlock(payload.payload));
    pushSection(lines, ...details);
    return;
  }

  if (event.type === 'approval.decided' && typeof payload.approvalId === 'string') {
    const details = [
      heading('Approval outcome'),
      `- **Approval ID:** ${inlineCode(payload.approvalId)}`,
      `- **Status:** ${typeof payload.status === 'string' ? payload.status : 'unknown'}`,
    ];
    if (typeof payload.decidedBy === 'string') details.push(`- **Decided by:** ${inlineCode(payload.decidedBy)}`);
    pushSection(lines, ...details);
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
