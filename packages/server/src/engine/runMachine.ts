/**
 * 定位「带 runId 上下文的机器执行」应落的机器（issue #47 不变量）：
 * 跟随该 run 的会话机器——run 的 worktree/cwd 就在那台，gh/git 必可用。
 * 纯匹配逻辑抽出（仿 scheduler.chooseMachine）便于单测；DB/在线态在 machineForRun 注入。
 */
import { desc, eq } from 'drizzle-orm';
import { workflowDefSchema, type AgentNode, type MachineInfo } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { schedulableMachines } from '../services/machineScheduling';
import { listMachines } from '../ws/runnerHub';

/** 纯：按 id / 全部 labels 命中未暂停调度的在线机（与 engine.pickMachine 同语义）。 */
export function matchMachine(online: MachineInfo[], selector: AgentNode['machine']): string | null {
  const schedulable = schedulableMachines(online);
  if (selector?.id) {
    return schedulable.some((m) => m.id === selector.id) ? selector.id : null;
  }
  const labels = selector?.labels ?? [];
  const match = schedulable.find((m) => labels.every((l) => m.labels.includes(l)));
  return match?.id ?? null;
}

/** 纯：① run 最新会话机仍可调度 → 用它；② 回退首个命中 agent 选择器的可调度在线机；③ null。 */
export function resolveRunMachine(
  online: MachineInfo[],
  latestSessionMachineId: string | null,
  agentSelectors: Array<AgentNode['machine']>,
): string | null {
  const schedulable = schedulableMachines(online);
  if (latestSessionMachineId && schedulable.some((m) => m.id === latestSessionMachineId)) {
    return latestSessionMachineId;
  }
  for (const sel of agentSelectors) {
    const m = matchMachine(schedulable, sel);
    if (m) return m;
  }
  return null;
}

/** 异步壳：查该 run 最新会话机 + def 里 agent 选择器，交纯函数定位。找不到 → null（调用方响亮失败）。 */
export async function machineForRun(runId: string): Promise<string | null> {
  const db = getDb();
  const sess = (
    await db
      .select({ machineId: schema.sessions.machineId })
      .from(schema.sessions)
      .where(eq(schema.sessions.runId, runId))
      .orderBy(desc(schema.sessions.createdAt))
      .limit(1)
  )[0];

  const selectors: Array<AgentNode['machine']> = [];
  const run = (
    await db.select({ defId: schema.workflowRuns.defId }).from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId)).limit(1)
  )[0];
  if (run?.defId) {
    const defRow = (
      await db.select({ graph: schema.workflowDefs.graph }).from(schema.workflowDefs)
        .where(eq(schema.workflowDefs.id, run.defId)).limit(1)
    )[0];
    const parsed = defRow ? workflowDefSchema.safeParse(defRow.graph) : undefined;
    if (parsed?.success) {
      for (const node of parsed.data.nodes) {
        if (node.type === 'agent' && node.machine) selectors.push(node.machine);
      }
    }
  }
  return resolveRunMachine(listMachines(), sess?.machineId ?? null, selectors);
}
