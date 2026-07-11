/**
 * 单个工作流运行的暂停/恢复控制。
 * 状态条件更新与 run.status 审计事件同事务提交，并与引擎 tick 共用 run 级串行链。
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { scheduleTick, serializeRunProgression } from '../engine/engine';
import { bus } from '../events';

const PAUSABLE_RUN_STATUSES = ['running', 'waiting_human'] as const;

export class WorkflowRunProgressionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowRunProgressionRecord {
  id: string;
  status: string;
}

export interface WorkflowRunProgressionEventPayload {
  status: 'running' | 'waiting_human' | 'paused';
  by: string;
}

export interface WorkflowRunProgressionTransition {
  run: WorkflowRunProgressionRecord;
  eventSeq: number;
  eventPayload: WorkflowRunProgressionEventPayload;
}

type ProgressionAction = 'pause' | 'resume';

export interface WorkflowRunProgressionDependencies {
  load: (runId: string) => Promise<WorkflowRunProgressionRecord | null>;
  transition: (
    runId: string,
    action: ProgressionAction,
    by: string,
  ) => Promise<WorkflowRunProgressionTransition | null>;
  notify: (runId: string, eventSeq: number, payload: WorkflowRunProgressionEventPayload) => void;
  serialize: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
  schedule: (runId: string) => void;
}

export function workflowRunPauseBlockReason(run: WorkflowRunProgressionRecord): string | null {
  if (!PAUSABLE_RUN_STATUSES.includes(run.status as (typeof PAUSABLE_RUN_STATUSES)[number])) {
    return `run cannot be paused from status: ${run.status}`;
  }
  return null;
}

export function workflowRunResumeBlockReason(run: WorkflowRunProgressionRecord): string | null {
  return run.status === 'paused' ? null : `run is not paused: ${run.status}`;
}

const productionDependencies: WorkflowRunProgressionDependencies = {
  async load(runId) {
    const rows = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
    return rows[0] ?? null;
  },
  async transition(runId, action, by) {
    return getDb().transaction(async (tx) => {
      let target: WorkflowRunProgressionEventPayload['status'];
      if (action === 'pause') {
        target = 'paused';
      } else {
        const waitingNodes = await tx
          .select({ nodeId: schema.nodeStates.nodeId })
          .from(schema.nodeStates)
          .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.status, 'waiting_human')))
          .limit(1);
        target = waitingNodes.length > 0 ? 'waiting_human' : 'running';
      }

      const changedRows = await tx
        .update(schema.workflowRuns)
        .set({ status: target })
        .where(
          action === 'pause'
            ? and(eq(schema.workflowRuns.id, runId), inArray(schema.workflowRuns.status, [...PAUSABLE_RUN_STATUSES]))
            : and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.status, 'paused')),
        )
        .returning();
      const changed = changedRows[0];
      if (!changed) return null;

      const eventPayload: WorkflowRunProgressionEventPayload = { status: target, by };
      const eventRows = await tx
        .insert(schema.events)
        .values({ runId, type: 'run.status', payload: eventPayload })
        .returning({ seq: schema.events.seq });
      const eventSeq = eventRows[0]?.seq;
      if (eventSeq === undefined) {
        throw new Error(`failed to persist progression event for run ${runId}`);
      }

      return { run: changed, eventSeq, eventPayload };
    });
  },
  notify(runId, eventSeq, payload) {
    bus.emit('event', { type: 'run.status', runId, payload, seq: eventSeq });
  },
  serialize: serializeRunProgression,
  schedule: scheduleTick,
};

async function changeWorkflowRunProgression(
  runId: string,
  action: ProgressionAction,
  by: string,
  deps: WorkflowRunProgressionDependencies,
): Promise<WorkflowRunProgressionTransition> {
  return deps.serialize(runId, async () => {
    const found = await deps.load(runId);
    if (!found) {
      throw new WorkflowRunProgressionError(404, `run not found: ${runId}`);
    }
    const blocked = action === 'pause'
      ? workflowRunPauseBlockReason(found)
      : workflowRunResumeBlockReason(found);
    if (blocked) {
      throw new WorkflowRunProgressionError(409, blocked);
    }

    const transitioned = await deps.transition(runId, action, by);
    if (!transitioned) {
      throw new WorkflowRunProgressionError(409, `run is no longer eligible to ${action}`);
    }
    deps.notify(runId, transitioned.eventSeq, transitioned.eventPayload);
    if (action === 'resume') {
      deps.schedule(runId);
    }
    return transitioned;
  });
}

export function pauseWorkflowRunWithDependencies(
  runId: string,
  by: string,
  deps: WorkflowRunProgressionDependencies,
): Promise<WorkflowRunProgressionTransition> {
  return changeWorkflowRunProgression(runId, 'pause', by, deps);
}

export function resumeWorkflowRunWithDependencies(
  runId: string,
  by: string,
  deps: WorkflowRunProgressionDependencies,
): Promise<WorkflowRunProgressionTransition> {
  return changeWorkflowRunProgression(runId, 'resume', by, deps);
}

export function pauseWorkflowRun(runId: string, by: string): Promise<WorkflowRunProgressionTransition> {
  return pauseWorkflowRunWithDependencies(runId, by, productionDependencies);
}

export function resumeWorkflowRun(runId: string, by: string): Promise<WorkflowRunProgressionTransition> {
  return resumeWorkflowRunWithDependencies(runId, by, productionDependencies);
}
