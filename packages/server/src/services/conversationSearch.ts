import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

const RESULT_LIMIT = 50;
const SNIPPET_LENGTH = 180;

export interface ConversationSearchDbRow {
  eventSeq: number;
  sessionId: string;
  sessionTitle: string | null;
  sessionCwd: string;
  sessionArchivedAt: Date | null;
  runId: string | null;
  runTitle: string | null;
  defName: string | null;
  runArchivedAt: Date | null;
  projectId: string | null;
  role: string;
  text: string;
}

export interface ConversationSearchResult {
  kind: 'session' | 'run';
  id: string;
  sessionId: string;
  title: string;
  snippet: string;
  role: 'user' | 'agent';
  archived: boolean;
  projectId: string | null;
  eventSeq: number;
}

function fallbackSessionTitle(row: ConversationSearchDbRow): string {
  const cwdPart = row.sessionCwd.split(/[\\/]/).filter(Boolean).pop();
  return cwdPart || `Session ${row.sessionId.slice(0, 8)}`;
}

/** Build a compact, whitespace-normalized excerpt centered on the first match. */
export function conversationSearchSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= SNIPPET_LENGTH) return normalized;

  const matchAt = normalized.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const center = matchAt >= 0 ? matchAt + Math.floor(query.trim().length / 2) : 0;
  const start = Math.max(0, Math.min(center - Math.floor(SNIPPET_LENGTH / 2), normalized.length - SNIPPET_LENGTH));
  const excerpt = normalized.slice(start, start + SNIPPET_LENGTH).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + SNIPPET_LENGTH < normalized.length ? '…' : ''}`;
}

/** Collapse child-session matches into their owning run and retain its newest match. */
export function mapConversationSearchRows(
  rows: ConversationSearchDbRow[],
  query: string,
  limit = RESULT_LIMIT,
): ConversationSearchResult[] {
  const results: ConversationSearchResult[] = [];
  const seen = new Set<string>();

  for (const row of [...rows].sort((left, right) => right.eventSeq - left.eventSeq)) {
    if (row.role !== 'user' && row.role !== 'agent') continue;
    const kind = row.runId ? 'run' : 'session';
    const id = row.runId ?? row.sessionId;
    const parentKey = `${kind}:${id}`;
    if (seen.has(parentKey)) continue;
    seen.add(parentKey);
    results.push({
      kind,
      id,
      sessionId: row.sessionId,
      title: row.runId
        ? row.runTitle?.trim() || row.defName?.trim() || `Run ${row.runId.slice(0, 8)}`
        : row.sessionTitle?.trim() || fallbackSessionTitle(row),
      snippet: conversationSearchSnippet(row.text, query),
      role: row.role,
      archived: row.runId ? row.runArchivedAt !== null : row.sessionArchivedAt !== null,
      projectId: row.projectId,
      eventSeq: row.eventSeq,
    });
    if (results.length >= limit) break;
  }

  return results;
}

export async function searchConversationContent(
  query: string,
  projectId?: string,
): Promise<ConversationSearchResult[]> {
  const db = getDb();
  const messageText = sql<string>`${schema.events.payload}->'ev'->>'text'`;
  const messageRole = sql<string>`${schema.events.payload}->>'role'`;
  const effectiveRunId = sql<string | null>`coalesce(${schema.sessions.runId}, ${schema.events.runId})`;
  const effectiveProjectId = sql<string | null>`coalesce(${schema.workflowRuns.projectId}, ${schema.sessions.projectId})`;
  const parentKey = sql<string>`case
    when ${effectiveRunId} is not null then 'run:' || ${effectiveRunId}
    else 'session:' || ${schema.sessions.id}
  end`;
  const scopeCondition = projectId ? eq(effectiveProjectId, projectId) : undefined;

  const matches = db
    .selectDistinctOn([parentKey], {
      eventSeq: schema.events.seq,
      sessionId: schema.sessions.id,
      sessionTitle: schema.sessions.title,
      sessionCwd: schema.sessions.cwd,
      sessionArchivedAt: schema.sessions.archivedAt,
      runId: effectiveRunId.as('run_id'),
      runTitle: schema.workflowRuns.title,
      defName: schema.workflowDefs.name,
      runArchivedAt: schema.workflowRuns.archivedAt,
      projectId: effectiveProjectId.as('project_id'),
      role: messageRole.as('message_role'),
      text: messageText.as('message_text'),
    })
    .from(schema.events)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.events.sessionId))
    .leftJoin(schema.workflowRuns, eq(schema.workflowRuns.id, effectiveRunId))
    .leftJoin(schema.workflowDefs, eq(schema.workflowDefs.id, schema.workflowRuns.defId))
    .where(and(
      eq(schema.events.type, 'session.message'),
      sql`${messageRole} in ('user', 'agent')`,
      sql`${schema.events.payload}->'ev'->>'t' = 'text'`,
      sql`coalesce(${schema.events.payload}->'ev'->>'thinking', 'false') <> 'true'`,
      sql`strpos(lower(${messageText}), lower(${query})) > 0`,
      scopeCondition,
    ))
    .orderBy(parentKey, desc(schema.events.seq))
    .as('conversation_matches');

  const rows = await db
    .select()
    .from(matches)
    .orderBy(desc(matches.eventSeq))
    .limit(RESULT_LIMIT);

  return mapConversationSearchRows(rows, query);
}
