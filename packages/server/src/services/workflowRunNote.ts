import type { RunNotePayload } from '@co/protocol';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { publish, type OrchEvent } from '../events';

export interface WorkflowRunNoteEvent {
  seq: number;
  type: 'run.note';
  runId: string;
  payload: RunNotePayload;
}

export interface WorkflowRunNoteDependencies {
  runExists: (runId: string) => Promise<boolean>;
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
