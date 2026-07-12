import type { RunNoteDeletionPayload, RunNotePayload, RunNoteRevisionPayload } from '@co/protocol';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { publish, type OrchEvent } from '../events';

export interface WorkflowRunNoteEvent {
  seq: number;
  type: 'run.note';
  runId: string;
  payload: RunNotePayload;
}

export interface WorkflowRunNoteRevisionEvent {
  seq: number;
  type: 'run.note.updated';
  runId: string;
  payload: RunNoteRevisionPayload;
}

export interface WorkflowRunNoteDeletionEvent {
  seq: number;
  type: 'run.note.deleted';
  runId: string;
  payload: RunNoteDeletionPayload;
}

export interface WorkflowRunNoteDependencies {
  runExists: (runId: string) => Promise<boolean>;
  noteExists: (runId: string, noteId: number) => Promise<boolean>;
  publishEvent: (event: OrchEvent) => Promise<number>;
}

export class WorkflowRunNoteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const defaultDependencies: WorkflowRunNoteDependencies = {
  async runExists(runId) {
    const rows = await getDb()
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .limit(1);
    return rows.length === 1;
  },
  async noteExists(runId, noteId) {
    const db = getDb();
    const rows = await db
      .select({ seq: schema.events.seq })
      .from(schema.events)
      .where(and(
        eq(schema.events.seq, noteId),
        eq(schema.events.runId, runId),
        eq(schema.events.type, 'run.note'),
      ))
      .limit(1);
    if (rows.length !== 1) return false;
    const deletions = await db
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(and(
        eq(schema.events.runId, runId),
        eq(schema.events.type, 'run.note.deleted'),
      ));
    return !deletions.some(({ payload }) => (payload as { noteId?: unknown }).noteId === noteId);
  },
  publishEvent: publish,
};

export async function appendWorkflowRunNoteWithDependencies(
  runId: string,
  payload: RunNotePayload,
  dependencies: WorkflowRunNoteDependencies,
): Promise<WorkflowRunNoteEvent> {
  if (!(await dependencies.runExists(runId))) {
    throw new WorkflowRunNoteError(404, 'run not found');
  }

  const event = { type: 'run.note' as const, runId, payload };
  const seq = await dependencies.publishEvent(event);
  return { ...event, seq };
}

export function appendWorkflowRunNote(runId: string, payload: RunNotePayload): Promise<WorkflowRunNoteEvent> {
  return appendWorkflowRunNoteWithDependencies(runId, payload, defaultDependencies);
}

export async function reviseWorkflowRunNoteWithDependencies(
  runId: string,
  payload: RunNoteRevisionPayload,
  dependencies: WorkflowRunNoteDependencies,
): Promise<WorkflowRunNoteRevisionEvent> {
  if (!(await dependencies.noteExists(runId, payload.noteId))) {
    throw new WorkflowRunNoteError(404, 'run note not found');
  }
  const event = { type: 'run.note.updated' as const, runId, payload };
  const seq = await dependencies.publishEvent(event);
  return { ...event, seq };
}

export function reviseWorkflowRunNote(
  runId: string,
  payload: RunNoteRevisionPayload,
): Promise<WorkflowRunNoteRevisionEvent> {
  return reviseWorkflowRunNoteWithDependencies(runId, payload, defaultDependencies);
}

export async function deleteWorkflowRunNoteWithDependencies(
  runId: string,
  payload: RunNoteDeletionPayload,
  dependencies: WorkflowRunNoteDependencies,
): Promise<WorkflowRunNoteDeletionEvent> {
  if (!(await dependencies.noteExists(runId, payload.noteId))) {
    throw new WorkflowRunNoteError(404, 'run note not found');
  }
  const event = { type: 'run.note.deleted' as const, runId, payload };
  const seq = await dependencies.publishEvent(event);
  return { ...event, seq };
}

export function deleteWorkflowRunNote(
  runId: string,
  payload: RunNoteDeletionPayload,
): Promise<WorkflowRunNoteDeletionEvent> {
  return deleteWorkflowRunNoteWithDependencies(runId, payload, defaultDependencies);
}
