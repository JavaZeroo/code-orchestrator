/**
 * 终态工作流运行的归档状态转换。归档只更新 workflow_runs 的时间戳；
 * 条件更新确保并发请求或状态变化后仍会重新裁决资格。
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

const TERMINAL_RUN_STATUSES = ['done', 'failed', 'cancelled'] as const;

export class WorkflowRunArchiveError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowRunArchiveRecord {
  id: string;
  status: string;
  archivedAt: Date | null;
}

export interface WorkflowRunArchiveDependencies {
  load: (runId: string) => Promise<WorkflowRunArchiveRecord | null>;
  archive: (runId: string) => Promise<WorkflowRunArchiveRecord | null>;
  restore: (runId: string) => Promise<WorkflowRunArchiveRecord | null>;
}

export function workflowRunArchiveBlockReason(run: WorkflowRunArchiveRecord): string | null {
  if (run.archivedAt !== null) return 'run is already archived';
  if (!TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    return `run is still active: ${run.status}`;
  }
  return null;
}

export function workflowRunRestoreBlockReason(run: WorkflowRunArchiveRecord): string | null {
  if (run.archivedAt === null) return 'run is not archived';
  return null;
}

const productionDependencies: WorkflowRunArchiveDependencies = {
  async load(runId) {
    const rows = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
    return rows[0] ?? null;
  },
  async archive(runId) {
    const rows = await getDb()
      .update(schema.workflowRuns)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(schema.workflowRuns.id, runId),
          inArray(schema.workflowRuns.status, [...TERMINAL_RUN_STATUSES]),
          isNull(schema.workflowRuns.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async restore(runId) {
    const rows = await getDb()
      .update(schema.workflowRuns)
      .set({ archivedAt: null })
      .where(and(eq(schema.workflowRuns.id, runId), isNotNull(schema.workflowRuns.archivedAt)))
      .returning();
    return rows[0] ?? null;
  },
};

export async function archiveWorkflowRunWithDependencies(
  runId: string,
  deps: WorkflowRunArchiveDependencies,
): Promise<WorkflowRunArchiveRecord> {
  const found = await deps.load(runId);
  if (!found) {
    throw new WorkflowRunArchiveError(404, `run not found: ${runId}`);
  }
  const blocked = workflowRunArchiveBlockReason(found);
  if (blocked) {
    throw new WorkflowRunArchiveError(409, blocked);
  }
  const archived = await deps.archive(runId);
  if (!archived) {
    throw new WorkflowRunArchiveError(409, 'run is no longer eligible to archive');
  }
  return archived;
}

export async function restoreWorkflowRunWithDependencies(
  runId: string,
  deps: WorkflowRunArchiveDependencies,
): Promise<WorkflowRunArchiveRecord> {
  const found = await deps.load(runId);
  if (!found) {
    throw new WorkflowRunArchiveError(404, `run not found: ${runId}`);
  }
  const blocked = workflowRunRestoreBlockReason(found);
  if (blocked) {
    throw new WorkflowRunArchiveError(409, blocked);
  }
  const restored = await deps.restore(runId);
  if (!restored) {
    throw new WorkflowRunArchiveError(409, 'run is no longer eligible to restore');
  }
  return restored;
}

export function archiveWorkflowRun(runId: string): Promise<WorkflowRunArchiveRecord> {
  return archiveWorkflowRunWithDependencies(runId, productionDependencies);
}

export function restoreWorkflowRun(runId: string): Promise<WorkflowRunArchiveRecord> {
  return restoreWorkflowRunWithDependencies(runId, productionDependencies);
}
