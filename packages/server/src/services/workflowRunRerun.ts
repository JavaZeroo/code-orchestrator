/**
 * 从终态工作流启动一次全新运行：只复用定义、项目与原始 vars，
 * 不复用节点状态、输出或会话，也不修改源 run。
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { startRun } from '../engine/engine';

export class WorkflowRunRerunError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowRunRerunRecord {
  id: string;
  defId: string;
  projectId: string | null;
  status: string;
  context: Record<string, unknown>;
}

export interface WorkflowRunRerunDependencies {
  load: (runId: string) => Promise<WorkflowRunRerunRecord | null>;
  start: (defId: string, vars: Record<string, string>, projectId?: string | null, actorId?: string) => Promise<string>;
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function workflowRunRerunBlockReason(run: WorkflowRunRerunRecord): string | null {
  return TERMINAL_RUN_STATUSES.has(run.status) ? null : `run is still active: ${run.status}`;
}

export function reusableWorkflowRunVars(context: Record<string, unknown>): Record<string, string> {
  const vars = context.vars;
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new WorkflowRunRerunError(409, 'run does not contain reusable input variables');
  }
  const entries = Object.entries(vars);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw new WorkflowRunRerunError(409, 'run contains invalid input variables');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const productionDependencies: WorkflowRunRerunDependencies = {
  async load(runId) {
    const rows = await getDb()
      .select({
        id: schema.workflowRuns.id,
        defId: schema.workflowRuns.defId,
        projectId: schema.workflowRuns.projectId,
        status: schema.workflowRuns.status,
        context: schema.workflowRuns.context,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .limit(1);
    return rows[0] ?? null;
  },
  start: (defId, vars, projectId, actorId) => startRun(defId, vars, projectId, undefined, actorId),
};

export async function rerunWorkflowRunWithDependencies(
  sourceRunId: string,
  deps: WorkflowRunRerunDependencies,
  actorId?: string,
): Promise<{ runId: string }> {
  const source = await deps.load(sourceRunId);
  if (!source) {
    throw new WorkflowRunRerunError(404, `run not found: ${sourceRunId}`);
  }
  const blocked = workflowRunRerunBlockReason(source);
  if (blocked) {
    throw new WorkflowRunRerunError(409, blocked);
  }

  const vars = reusableWorkflowRunVars(source.context);
  const runId = actorId
    ? await deps.start(source.defId, vars, source.projectId, actorId)
    : await deps.start(source.defId, vars, source.projectId);
  return { runId };
}

export function rerunWorkflowRun(sourceRunId: string, actorId?: string): Promise<{ runId: string }> {
  return rerunWorkflowRunWithDependencies(sourceRunId, productionDependencies, actorId);
}
