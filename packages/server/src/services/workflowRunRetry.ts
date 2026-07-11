/**
 * 失败工作流的原地重试：用 workflow_runs 的条件更新抢占唯一重试权，
 * 同事务重置失败节点、清理失败输出并写审计事件，再交回引擎续跑。
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { scheduleRetriedRun } from '../engine/engine';
import { bus } from '../events';

export class WorkflowRunRetryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowRunRetryRecord {
  id: string;
  status: string;
  context: Record<string, unknown>;
  endedAt: Date | null;
  archivedAt: Date | null;
}

export interface WorkflowRunRetryEventPayload {
  by: string;
  retriedNodeIds: string[];
}

export interface WorkflowRunRetryTransition {
  run: WorkflowRunRetryRecord;
  retriedNodeIds: string[];
  eventSeq: number;
  eventPayload: WorkflowRunRetryEventPayload;
}

export interface WorkflowRunRetryDependencies {
  load: (runId: string) => Promise<WorkflowRunRetryRecord | null>;
  /** failed → running、失败节点 → pending 与审计事件必须在同一事务中完成。 */
  transition: (runId: string, by: string) => Promise<WorkflowRunRetryTransition | null>;
  notify: (runId: string, eventSeq: number, payload: WorkflowRunRetryEventPayload) => void;
  schedule: (runId: string, retriedNodeIds: string[]) => void;
}

export function workflowRunRetryBlockReason(run: WorkflowRunRetryRecord): string | null {
  if (run.archivedAt !== null) return 'archived runs must be restored before retrying';
  if (run.status !== 'failed') return `run is not failed: ${run.status}`;
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 只清掉本次失败节点的模板输出；完成/跳过节点及其它上下文保持原样。 */
export function clearRetriedNodeOutputs(
  context: Record<string, unknown>,
  retriedNodeIds: string[],
): Record<string, unknown> {
  const outputs = { ...objectRecord(context.outputs) };
  for (const nodeId of retriedNodeIds) {
    delete outputs[nodeId];
  }
  return { ...context, outputs };
}

const productionDependencies: WorkflowRunRetryDependencies = {
  async load(runId) {
    const rows = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
    return rows[0] ?? null;
  },
  async transition(runId, by) {
    return getDb().transaction(async (tx) => {
      // 先用 run 行抢占：并发 retry/archive 或状态变化后，只有一个请求能命中。
      const claimedRows = await tx
        .update(schema.workflowRuns)
        .set({ status: 'running', endedAt: null })
        .where(
          and(
            eq(schema.workflowRuns.id, runId),
            eq(schema.workflowRuns.status, 'failed'),
            isNull(schema.workflowRuns.archivedAt),
          ),
        )
        .returning();
      const claimed = claimedRows[0];
      if (!claimed) return null;

      const failedNodes = await tx
        .select({ nodeId: schema.nodeStates.nodeId })
        .from(schema.nodeStates)
        .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.status, 'failed')))
        .orderBy(schema.nodeStates.nodeId);
      const retriedNodeIds = failedNodes.map((node) => node.nodeId);
      const context = clearRetriedNodeOutputs(claimed.context, retriedNodeIds);

      await tx
        .update(schema.nodeStates)
        .set({ status: 'pending', sessionId: null, output: null, updatedAt: new Date() })
        .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.status, 'failed')));
      await tx
        .update(schema.workflowRuns)
        .set({ context })
        .where(eq(schema.workflowRuns.id, runId));

      const eventPayload: WorkflowRunRetryEventPayload = { by, retriedNodeIds };
      const eventRows = await tx
        .insert(schema.events)
        .values({ runId, type: 'run.retried', payload: eventPayload })
        .returning({ seq: schema.events.seq });
      const eventSeq = eventRows[0]?.seq;
      if (eventSeq === undefined) {
        throw new Error(`failed to persist retry event for run ${runId}`);
      }

      return {
        run: { ...claimed, context },
        retriedNodeIds,
        eventSeq,
        eventPayload,
      };
    });
  },
  notify(runId, eventSeq, payload) {
    bus.emit('event', { type: 'run.retried', runId, payload, seq: eventSeq });
  },
  schedule: scheduleRetriedRun,
};

export async function retryWorkflowRunWithDependencies(
  runId: string,
  by: string,
  deps: WorkflowRunRetryDependencies,
): Promise<WorkflowRunRetryTransition> {
  const found = await deps.load(runId);
  if (!found) {
    throw new WorkflowRunRetryError(404, `run not found: ${runId}`);
  }
  const blocked = workflowRunRetryBlockReason(found);
  if (blocked) {
    throw new WorkflowRunRetryError(409, blocked);
  }

  const transitioned = await deps.transition(runId, by);
  if (!transitioned) {
    throw new WorkflowRunRetryError(409, 'run is no longer eligible to retry');
  }
  deps.notify(runId, transitioned.eventSeq, transitioned.eventPayload);
  deps.schedule(runId, transitioned.retriedNodeIds);
  return transitioned;
}

export function retryWorkflowRun(runId: string, by: string): Promise<WorkflowRunRetryTransition> {
  return retryWorkflowRunWithDependencies(runId, by, productionDependencies);
}
