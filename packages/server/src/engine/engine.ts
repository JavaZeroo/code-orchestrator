/**
 * 工作流引擎（M2）：事件驱动的薄状态机，设计文档 §7。
 * - startRun：建 run + 全量 node_states(pending)，触发首次 tick
 * - tick：按 DAG 就绪判定执行节点（按 runId 串行化，幂等）
 * - agent 节点：挑机器 → spawn 会话 → 监听该会话 turn-end → 捕获输出进 context.outputs
 * - gate 节点：建 kind=gate 审批，挂起（可挂数天）；决议后恢复
 * - 崩溃恢复：boot 时重建 会话→节点 索引，补查漏掉的 turn-end
 * M2 仅支持 agent | gate 节点；其余类型在 startRun 拒绝。
 */

import { existsSync } from 'node:fs';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  workflowDefSchema,
  type AgentNode,
  type ApprovalDecision,
  type CheckNode,
  type GateNode,
  type MeetingNode,
  type SessionEnvelope,
  type WorkflowDef,
} from '@co/protocol';
import { getDb, schema } from '../db/index';
import { bus, publish } from '../events';
import { parseForgeUrl } from '../forge/registry';
import { callRunner, listMachines } from '../ws/runnerHub';
import { spawnSession, SpawnError } from '../services/spawn';
import { machineForRun, matchMachine } from './runMachine';

type RunContext = {
  vars: Record<string, string>;
  outputs: Record<string, string>;
  /** 每个评审节点已用返工轮次（持久化在 run.context，重启后仍守住上限） */
  reviseRounds?: Record<string, number>;
};
type ApprovalRow = typeof schema.approvals.$inferSelect;

export class EngineError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** 会话 → 所属节点（内存索引，boot 时从 DB 重建） */
const sessionNodes = new Map<string, { runId: string; nodeId: string }>();
/** 每个 run 的 tick 串行链，避免并发状态竞争 */
const tickChains = new Map<string, Promise<void>>();

/** agent 节点重试计数（key=runId:nodeId），瞬时错误自愈用 */
const agentAttempts = new Map<string, number>();
const MAX_AGENT_RETRIES = Number(process.env.AGENT_MAX_RETRIES ?? 2);
// 返工轮次已改为持久化在 run.context.reviseRounds（重启后仍守上限），不再用内存 Map
/** turn 名义 completed 但实际是传输层/限流错误（SDK 有时把 API 错误也标 success）——判为可重试失败 */
const TRANSIENT_ERROR_RE = /^\s*(API Error|Unable to connect to API|ECONNRESET|ETIMEDOUT|overloaded_error|rate_limit|Internal server error|502 |503 |529 )/i;

function parseDef(graph: unknown): WorkflowDef {
  return workflowDefSchema.parse(graph);
}

function substitute(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    if (key.startsWith('outputs.')) {
      return ctx.outputs[key.slice('outputs.'.length)] ?? '';
    }
    const name = key.startsWith('vars.') ? key.slice('vars.'.length) : key;
    return ctx.vars[name] ?? '';
  });
}

function depsOf(def: WorkflowDef, nodeId: string): string[] {
  return def.edges.filter(([, to]) => to === nodeId).map(([from]) => from);
}

async function publishNodeState(runId: string, nodeId: string, status: string, extra?: Record<string, unknown>) {
  await publish({ type: 'run.node.state', runId, payload: { nodeId, status, ...extra } });
}

// ---------- 启动 ----------

type RunTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** 可选 hook 与 run/node 建账同事务执行；用于把外部来源记录原子链接到新 run。 */
export async function startRun(
  defId: string,
  vars: Record<string, string>,
  projectId?: string,
  onCreate?: (tx: RunTransaction, runId: string) => Promise<void>,
): Promise<string> {
  const db = getDb();
  const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, defId)).limit(1);
  const defRow = defRows[0];
  if (!defRow) {
    throw new EngineError(404, `workflow not found: ${defId}`);
  }
  const def = parseDef(defRow.graph);
  const unsupported = def.nodes.filter((n) => !['agent', 'gate', 'meeting', 'check'].includes(n.type));
  if (unsupported.length > 0) {
    throw new EngineError(400, `当前支持 agent|gate|meeting|check 节点，含不支持类型: ${unsupported.map((n) => `${n.id}(${n.type})`).join(', ')}`);
  }

  const runId = createId();
  const context: RunContext = { vars: { ...(def.vars ?? {}), ...vars }, outputs: {} };
  const effectiveProjectId = projectId ?? defRow.projectId ?? undefined;
  await db.transaction(async (tx) => {
    await tx.insert(schema.workflowRuns).values({ id: runId, defId, projectId: effectiveProjectId, status: 'running', context });
    await tx
      .insert(schema.nodeStates)
      .values(def.nodes.map((n) => ({ runId, nodeId: n.id, status: 'pending' as const })));
    await onCreate?.(tx, runId);
  });
  await publish({ type: 'run.started', runId, payload: { defId, name: def.name, vars: context.vars, projectId: effectiveProjectId } });
  scheduleTick(runId);
  return runId;
}

// ---------- tick ----------

export function scheduleTick(runId: string): void {
  const prev = tickChains.get(runId) ?? Promise.resolve();
  const next = prev
    .then(() => tick(runId))
    .catch((err) => {
      console.error(`[engine] tick failed for run ${runId}:`, err);
    });
  tickChains.set(runId, next);
}

async function tick(runId: string): Promise<void> {
  const db = getDb();
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run || run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
    return;
  }
  const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
  if (!defRows[0]) {
    return;
  }
  const def = parseDef(defRows[0].graph);
  const states = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
  const byId = new Map(states.map((s) => [s.nodeId, s]));
  const context = run.context as RunContext;

  // 终态判定
  if (states.some((s) => s.status === 'failed')) {
    await finishRun(runId, 'failed');
    return;
  }
  if (states.every((s) => s.status === 'done' || s.status === 'skipped')) {
    await finishRun(runId, 'done');
    return;
  }

  // 就绪节点：pending 且所有依赖 done
  const ready = def.nodes.filter((n) => {
    const st = byId.get(n.id);
    if (!st || st.status !== 'pending') {
      return false;
    }
    return depsOf(def, n.id).every((dep) => byId.get(dep)?.status === 'done');
  });

  for (const node of ready) {
    if (node.type === 'agent') {
      await execAgent(runId, node, context);
    } else if (node.type === 'gate') {
      await execGate(runId, node, context);
    } else if (node.type === 'meeting') {
      await execMeeting(runId, node, context);
    } else if (node.type === 'check') {
      await execCheck(runId, node, context);
    }
  }

  // run 级状态：有 waiting_human 节点则整体 waiting_human
  const after = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
  const waiting = after.some((s) => s.status === 'waiting_human');
  const target = waiting ? 'waiting_human' : 'running';
  if (run.status !== target) {
    await db.update(schema.workflowRuns).set({ status: target }).where(eq(schema.workflowRuns.id, runId));
    await publish({ type: 'run.status', runId, payload: { status: target } });
  }
}

async function finishRun(runId: string, status: 'done' | 'failed' | 'cancelled'): Promise<void> {
  const db = getDb();
  await db
    .update(schema.workflowRuns)
    .set({ status, endedAt: new Date() })
    .where(eq(schema.workflowRuns.id, runId));
  await publish({ type: 'run.finished', runId, payload: { status } });
}

// ---------- 节点执行 ----------

function pickMachine(selector: AgentNode['machine']): string | null {
  return matchMachine(listMachines(), selector);
}

async function execAgent(runId: string, node: AgentNode, context: RunContext): Promise<void> {
  const db = getDb();
  const machineId = pickMachine(node.machine);
  const cwdTpl = node.cwd ?? context.vars.cwd;

  const fail = async (error: string) => {
    await db
      .update(schema.nodeStates)
      .set({ status: 'failed', output: { error }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
    await publishNodeState(runId, node.id, 'failed', { error });
    scheduleTick(runId);
  };

  if (!machineId) {
    await fail(`没有匹配的可调度在线机器（selector: ${JSON.stringify(node.machine ?? {})}）`);
    return;
  }
  if (!cwdTpl) {
    await fail(`节点未指定 cwd 且运行时 vars.cwd 缺失`);
    return;
  }

  const meta: NonNullable<Parameters<typeof spawnSession>[0]['meta']> = {};
  if (node.role) {
    meta.appendSystemPrompt = `你在工作流中承担「${node.role}」角色。`;
  }
  if (node.permissionMode) {
    meta.permissionMode = node.permissionMode;
  }
  if (node.effort) {
    meta.effort = node.effort;
  }

  try {
    const { sessionId } = await spawnSession({
      machineId,
      cwd: substitute(cwdTpl, context),
      prompt: substitute(node.prompt, context),
      agent: node.cli,
      model: node.model,
      role: node.role,
      runId,
      nodeId: node.id,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    });
    sessionNodes.set(sessionId, { runId, nodeId: node.id });
    await db
      .update(schema.nodeStates)
      .set({ status: 'running', sessionId, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
    await publishNodeState(runId, node.id, 'running', { sessionId });
  } catch (err) {
    await fail(err instanceof SpawnError ? err.message : String(err));
  }
}

async function execGate(runId: string, node: GateNode, context: RunContext): Promise<void> {
  const db = getDb();
  const approvalId = createId();
  const title = node.title ? substitute(node.title, context) : undefined;
  await db.insert(schema.approvals).values({
    id: approvalId,
    kind: 'gate',
    runId,
    nodeId: node.id,
    title: title ?? `Gate: ${node.id}`,
    payload: { approvers: node.approvers },
    status: 'pending',
  });
  await db
    .update(schema.nodeStates)
    .set({ status: 'waiting_human', updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
  await publish({
    type: 'approval.requested',
    runId,
    payload: { id: approvalId, kind: 'gate', runId, nodeId: node.id, title: title ?? node.id, payload: { approvers: node.approvers }, requestedAt: Date.now() },
  });
  await publishNodeState(runId, node.id, 'waiting_human', { approvalId });
}

/** command-critic 节点：在 worktree 跑命令(exit0=pass)，产结构化裁决；
 *  失败且配了 reviseLoop → 回灌 target 返工、重跑本 check(复用 triggerRevision)。这是 TDD 红绿内环 / typecheck 门的机制。 */
async function execCheck(runId: string, node: CheckNode, context: RunContext): Promise<void> {
  const db = getDb();
  const setDone = async (pass: boolean, detail: string, exitCode: number) => {
    await db
      .update(schema.nodeStates)
      .set({ status: 'done', output: { kind: 'check', pass, detail, exitCode }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
    const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
    if (runRows[0]) {
      const ctx = runRows[0].context as RunContext;
      ctx.outputs[node.id] = pass ? 'PASS' : `FAIL(exit ${exitCode}): ${detail.slice(0, 800)}`;
      await db.update(schema.workflowRuns).set({ context: ctx }).where(eq(schema.workflowRuns.id, runId));
    }
    await publish({ type: 'run.check', runId, payload: { nodeId: node.id, pass, exitCode } });
    await publishNodeState(runId, node.id, 'done', { pass, exitCode });
    scheduleTick(runId);
  };
  const fail = async (error: string) => {
    await db
      .update(schema.nodeStates)
      .set({ status: 'failed', output: { error }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
    await publishNodeState(runId, node.id, 'failed', { error });
    scheduleTick(runId);
  };

  const machineId = await machineForRun(runId);
  const cwd = context.vars.cwd;
  if (!machineId) {
    return fail('无法定位该 run 的在线会话机器（check）');
  }
  if (!cwd) {
    return fail('check 需要 vars.cwd（worktree）');
  }
  const critic = node.critic; // 目前只 command 型
  await db
    .update(schema.nodeStates)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
  await publishNodeState(runId, node.id, 'running');

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await callRunner(machineId, 'machine.exec', {
      cmd: substitute(critic.run, context),
      cwd: substitute(cwd, context),
      timeoutMs: critic.timeoutMs,
    });
  } catch (err) {
    return fail(`command-critic 执行失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pass = result.exitCode === 0;
  const detail = pass ? 'ok' : (result.stderr || result.stdout).slice(-3000);
  console.log(`[engine] check ${node.id} → ${pass ? 'PASS' : `FAIL(exit ${result.exitCode})`} (run ${runId})`);

  // 失败 + 有返工闭环 → 回灌 target 修，重跑本 check
  if (!pass && node.reviseLoop) {
    const feedback = `command-critic「${node.title ?? node.id}」未通过（命令 \`${critic.run}\`，exit ${result.exitCode}）：\n${detail}\n请修复使其通过，然后 commit + push（同分支同 PR）。`;
    if (await triggerRevision(runId, node.id, node.reviseLoop.target, feedback, node.reviseLoop.maxRounds)) {
      return; // 已返工：本 check→pending，target 改完 tick 重跑
    }
  }
  await setDone(pass, detail, result.exitCode);
}

// ---------- meeting 节点 ----------

interface MeetingOpinion {
  participant: string;
  model: string;
  verdict: 'approve' | 'reject' | 'abstain';
  score?: number;
  reasons?: string[];
  raw: string;
}

interface MeetingState {
  runId: string;
  nodeId: string;
  node: MeetingNode;
  /** 已做 {{vars}}/{{outputs}} 替换的标题（仲裁审批用，concludeMeeting 时已无 context） */
  title: string;
  cwd: string;
  pendingSessions: Map<string, number>;
  opinions: Array<MeetingOpinion | null>;
}

const meetings = new Map<string, MeetingState>();
/** 参与者/仲裁人会话 → 会议 key（与 sessionNodes 分开索引，避免走 agent 完成路径） */
const meetingSessions = new Map<string, { key: string; idx: number | 'arbiter' }>();

const meetingKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

/** 从会话最终文本尾部解析 JSON 结论块 */
function parseVerdictJson(text: string): { verdict?: string; score?: number; reasons?: string[]; summary?: string } | null {
  const matches = text.match(/\{[\s\S]*?\}(?=[^{}]*$)/);
  if (!matches) {
    return null;
  }
  try {
    return JSON.parse(matches[0]) as { verdict?: string; score?: number; reasons?: string[]; summary?: string };
  } catch {
    return null;
  }
}

function participantPrompt(node: MeetingNode, context: RunContext, role?: string): string {
  const subject = substitute(node.subject ?? '', context);
  return `你是一场评审会议的独立参与者${role ? `（角色：${role}）` : ''}。请独立评审以下议题，不代表最终结论。

## 议题
${subject}

## 要求
1. 给出你的分析。若议题材料已足够，直接评审，不必查看文件；确需查证时才读工作目录中的代码/文档
2. 回复的最后必须是一个 JSON 代码块，格式严格为：
{"verdict": "approve" 或 "reject", "score": 0到10的整数, "reasons": ["理由1", "理由2"]}`;
}

async function execMeeting(runId: string, node: MeetingNode, context: RunContext): Promise<void> {
  const db = getDb();
  const machineId = await machineForRun(runId);
  const cwd = context.vars.cwd ?? '/root';

  const fail = async (error: string) => {
    await db
      .update(schema.nodeStates)
      .set({ status: 'failed', output: { error }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
    await publishNodeState(runId, node.id, 'failed', { error });
    scheduleTick(runId);
  };

  if (!machineId) {
    await fail('无法定位该 run 的在线会话机器（会议参与者）');
    return;
  }

  const key = meetingKey(runId, node.id);
  const state: MeetingState = {
    runId,
    nodeId: node.id,
    node,
    title: node.title ? substitute(node.title, context) : node.id,
    cwd: substitute(cwd, context),
    pendingSessions: new Map(),
    opinions: node.participants.map(() => null),
  };
  meetings.set(key, state);

  await db
    .update(schema.nodeStates)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, node.id)));
  await publishNodeState(runId, node.id, 'running', { phase: 'review', participants: node.participants.length });

  for (let i = 0; i < node.participants.length; i++) {
    const p = node.participants[i]!;
    try {
      const { sessionId } = await spawnSession({
        machineId,
        cwd: state.cwd,
        prompt: participantPrompt(node, context, p.role),
        agent: p.cli,
        model: p.model,
        role: p.role,
        runId,
        nodeId: node.id,
        // 评审姿态：只读工具免审批；禁执行/改动类工具，防止在工作目录里无限游走
        meta: { allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'] },
      });
      state.pendingSessions.set(sessionId, i);
      meetingSessions.set(sessionId, { key, idx: i });
    } catch (err) {
      state.opinions[i] = {
        participant: p.role ?? `参与者${i + 1}`,
        model: p.model,
        verdict: 'abstain',
        raw: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (state.pendingSessions.size === 0) {
    await concludeMeeting(state);
  }
}

async function onMeetingSessionDone(sessionId: string, ref: { key: string; idx: number | 'arbiter' }): Promise<void> {
  meetingSessions.delete(sessionId);
  const state = meetings.get(ref.key);
  if (!state) {
    return;
  }
  const text = await lastAgentText(sessionId);
  const parsed = parseVerdictJson(text);

  if (ref.idx === 'arbiter') {
    const verdict = parsed?.verdict === 'approve' ? 'approve' : parsed?.verdict === 'reject' ? 'reject' : 'reject';
    await finishMeeting(state, verdict, `仲裁模型结论：${parsed?.summary ?? text.slice(0, 300)}`);
    return;
  }

  const p = state.node.participants[ref.idx]!;
  state.opinions[ref.idx] = {
    participant: p.role ?? `参与者${ref.idx + 1}`,
    model: p.model,
    verdict: parsed?.verdict === 'approve' ? 'approve' : parsed?.verdict === 'reject' ? 'reject' : 'abstain',
    score: typeof parsed?.score === 'number' ? parsed.score : undefined,
    reasons: Array.isArray(parsed?.reasons) ? parsed.reasons.map(String) : undefined,
    raw: text.slice(0, 1000),
  };
  state.pendingSessions.delete(sessionId);
  if (state.pendingSessions.size === 0) {
    await concludeMeeting(state);
  }
}

function minutesMarkdown(state: MeetingState): string {
  const rows = state.opinions
    .map((o, i) =>
      o
        ? `| ${o.participant} | ${o.model} | ${o.verdict} | ${o.score ?? '-'} | ${(o.reasons ?? []).join('；') || o.raw.slice(0, 120)} |`
        : `| 参与者${i + 1} | - | abstain | - | 无响应 |`,
    )
    .join('\n');
  return `| 参与者 | 模型 | 结论 | 评分 | 理由 |\n|---|---|---|---|---|\n${rows}`;
}

async function concludeMeeting(state: MeetingState): Promise<void> {
  const arbiter = state.node.arbiter;
  const minutes = minutesMarkdown(state);

  if (arbiter === 'vote') {
    const approvals = state.opinions.filter((o) => o?.verdict === 'approve').length;
    const verdict = approvals * 2 > state.node.participants.length ? 'approve' : 'reject';
    await finishMeeting(state, verdict, `投票：${approvals}/${state.node.participants.length} 赞成`);
    return;
  }

  if (arbiter === 'human') {
    const db = getDb();
    const approvalId = createId();
    await db.insert(schema.approvals).values({
      id: approvalId,
      kind: 'gate',
      runId: state.runId,
      nodeId: state.nodeId,
      title: `会议仲裁：${state.title}`,
      payload: { meeting: true, minutes, opinions: state.opinions },
      status: 'pending',
    });
    await db
      .update(schema.nodeStates)
      .set({ status: 'waiting_human', output: { minutes }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, state.runId), eq(schema.nodeStates.nodeId, state.nodeId)));
    await publish({
      type: 'approval.requested',
      runId: state.runId,
      payload: { id: approvalId, kind: 'gate', runId: state.runId, nodeId: state.nodeId, title: `会议仲裁：${state.title}`, payload: { minutes }, requestedAt: Date.now() },
    });
    await publishNodeState(state.runId, state.nodeId, 'waiting_human', { phase: 'arbitrate' });
    await writeMeetingRecord(state, 'human-pending', minutes);
    meetings.delete(meetingKey(state.runId, state.nodeId));
    scheduleTick(state.runId);
    return;
  }

  // 模型仲裁
  const machineId = await machineForRun(state.runId);
  if (!machineId) {
    await finishMeeting(state, 'reject', '仲裁失败：无法定位该 run 的在线会话机器');
    return;
  }
  const opinionsText = state.opinions
    .map((o, i) => `### ${o?.participant ?? `参与者${i + 1}`}（${o?.model ?? '-'}）：${o?.verdict ?? 'abstain'}\n${o?.raw ?? '无响应'}`)
    .join('\n\n');
  try {
    const { sessionId } = await spawnSession({
      machineId,
      cwd: state.cwd,
      prompt: `你是评审会议的仲裁人。以下是各参与者的独立意见：\n\n${opinionsText}\n\n请综合判断并给出最终结论。回复最后必须是 JSON：{"verdict":"approve" 或 "reject","summary":"一句话裁决理由"}`,
      model: arbiter.model,
      runId: state.runId,
      nodeId: state.nodeId,
      meta: { allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'] },
    });
    meetingSessions.set(sessionId, { key: meetingKey(state.runId, state.nodeId), idx: 'arbiter' });
    await publishNodeState(state.runId, state.nodeId, 'running', { phase: 'arbitrate', arbiter: arbiter.model });
  } catch (err) {
    await finishMeeting(state, 'reject', `仲裁会话创建失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeMeetingRecord(state: MeetingState, verdict: string, minutes: string): Promise<void> {
  await getDb().insert(schema.meetingRecords).values({
    id: createId(),
    runId: state.runId,
    nodeId: state.nodeId,
    participants: state.node.participants,
    rounds: state.opinions,
    verdict,
    minutesMd: minutes,
  });
}

async function finishMeeting(state: MeetingState, verdict: 'approve' | 'reject', note: string): Promise<void> {
  const db = getDb();
  const minutes = `${minutesMarkdown(state)}\n\n**裁决**：${verdict}（${note}）`;
  await writeMeetingRecord(state, verdict, minutes);

  const ok = verdict === 'approve';
  await db
    .update(schema.nodeStates)
    .set({ status: ok ? 'done' : 'failed', output: { verdict, summary: note, minutes }, updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, state.runId), eq(schema.nodeStates.nodeId, state.nodeId)));

  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, state.runId)).limit(1);
  if (runRows[0]) {
    const context = runRows[0].context as RunContext;
    context.outputs[state.nodeId] = `会议裁决：${verdict}。${note}\n${minutesMarkdown(state)}`;
    await db.update(schema.workflowRuns).set({ context }).where(eq(schema.workflowRuns.id, state.runId));
  }

  await publish({ type: 'meeting.concluded', runId: state.runId, payload: { nodeId: state.nodeId, verdict, note } });
  await publishNodeState(state.runId, state.nodeId, ok ? 'done' : 'failed', { verdict });
  meetings.delete(meetingKey(state.runId, state.nodeId));
  scheduleTick(state.runId);
}

/** gate 决议入口（approvals decide 路由分流到这里） */
export async function decideGate(approval: ApprovalRow, decision: ApprovalDecision, decidedBy?: string): Promise<void> {
  if (!approval.runId || !approval.nodeId) {
    throw new EngineError(400, 'gate approval missing runId/nodeId');
  }
  const db = getDb();
  const approved = decision.behavior === 'allow';
  await db
    .update(schema.approvals)
    .set({ status: approved ? 'approved' : 'denied', decision, decidedBy, decidedAt: new Date() })
    .where(eq(schema.approvals.id, approval.id));
  await db
    .update(schema.nodeStates)
    .set({ status: approved ? 'done' : 'failed', output: { decidedBy, decision: decision.behavior }, updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, approval.runId), eq(schema.nodeStates.nodeId, approval.nodeId)));
  await publish({
    type: 'approval.decided',
    runId: approval.runId,
    payload: { approvalId: approval.id, status: approved ? 'approved' : 'denied', decidedBy },
  });
  await publishNodeState(approval.runId, approval.nodeId, approved ? 'done' : 'failed');
  scheduleTick(approval.runId);
}

// ---------- agent 节点完成检测 ----------

/** 会话最后一条 agent 正文（输出捕获公用） */
async function lastAgentText(sessionId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.type, 'session.message')))
    .orderBy(desc(schema.events.seq))
    .limit(50);
  for (const row of rows) {
    const envelope = row.payload as SessionEnvelope;
    if (envelope?.role === 'agent' && envelope.ev?.t === 'text' && !envelope.ev.thinking) {
      return envelope.ev.text;
    }
  }
  return '';
}

/** agent 输出中的 gitcode/github PR URL → 自动登记 forge_ref（M3 门禁回流入口） */
async function autoRegisterForgeRefs(summary: string, ref: { runId: string; nodeId: string }, sessionId: string): Promise<void> {
  const db = getDb();
  const seen = new Set<string>();
  // 逐个 URL 用 parseForgeUrl 识别 forge + owner/repo/number（只登记 PR）
  for (const m of summary.matchAll(/https?:\/\/\S+/g)) {
    const parsed = parseForgeUrl(m[0]);
    if (!parsed || parsed.kind !== 'pr') {
      continue;
    }
    const { forge, repo, number } = parsed;
    const dedupeKey = `${forge}:${repo}#${number}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const existing = await db
      .select({ id: schema.forgeRefs.id })
      .from(schema.forgeRefs)
      .where(and(eq(schema.forgeRefs.repo, repo), eq(schema.forgeRefs.number, number), eq(schema.forgeRefs.active, 'yes')))
      .limit(1);
    if (existing.length > 0) {
      continue;
    }
    await db.insert(schema.forgeRefs).values({
      id: createId(),
      forge,
      kind: 'pr',
      repo,
      number,
      runId: ref.runId,
      nodeId: ref.nodeId,
      sessionId,
    });
    await publish({
      type: 'forge.ref_registered',
      runId: ref.runId,
      sessionId,
      payload: { forge, repo, number, nodeId: ref.nodeId },
    });
  }
}

async function completeAgentNode(sessionId: string, turnStatus: string): Promise<void> {
  const ref = sessionNodes.get(sessionId);
  if (!ref) {
    return;
  }
  const db = getDb();
  const key = `${ref.runId}:${ref.nodeId}`;
  const summary = await lastAgentText(sessionId);
  // turn 失败，或名义完成但产出是传输层/限流错误 → 判为出错（否则会把"没干活"当成功放行）
  const errored = turnStatus !== 'completed' || TRANSIENT_ERROR_RE.test(summary);

  if (errored) {
    const attempts = agentAttempts.get(key) ?? 0;
    if (attempts < MAX_AGENT_RETRIES && (await retryAgentNode(sessionId, ref, turnStatus, summary, attempts))) {
      return; // 已在同会话重发任务，保留 sessionNodes 映射等下一次 turn-end
    }
    agentAttempts.delete(key);
    sessionNodes.delete(sessionId);
    const error = `agent turn ${turnStatus}${summary ? `: ${summary.slice(0, 300)}` : ''}`;
    await db
      .update(schema.nodeStates)
      .set({ status: 'failed', output: { error, summary, turnStatus, attempts }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, ref.runId), eq(schema.nodeStates.nodeId, ref.nodeId)));
    await publishNodeState(ref.runId, ref.nodeId, 'failed', { sessionId, error });
    scheduleTick(ref.runId);
    return;
  }

  agentAttempts.delete(key);
  sessionNodes.delete(sessionId);
  await autoRegisterForgeRefs(summary, ref, sessionId);

  // 评审→返工闭环：本节点（评审）判「需改进」→ 把意见回灌 target 会话修改、重跑本节点
  const node = await loadAgentNode(ref.runId, ref.nodeId);
  if (node?.reviseLoop && verdictChangesRequested(summary)) {
    if (await triggerRevision(ref.runId, ref.nodeId, node.reviseLoop.target, summary, node.reviseLoop.maxRounds)) {
      return; // 已回灌 target 返工；其 turn-end → tick 会重跑本评审节点
    }
  }

  await db
    .update(schema.nodeStates)
    .set({ status: 'done', output: { summary, turnStatus }, updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, ref.runId), eq(schema.nodeStates.nodeId, ref.nodeId)));

  // 输出写进 run context 供下游模板引用
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, ref.runId)).limit(1);
  if (runRows[0]) {
    const context = runRows[0].context as RunContext;
    context.outputs[ref.nodeId] = summary;
    await db.update(schema.workflowRuns).set({ context }).where(eq(schema.workflowRuns.id, ref.runId));
  }

  await publishNodeState(ref.runId, ref.nodeId, 'done', { sessionId });
  scheduleTick(ref.runId);
}

/** 瞬时错误自愈：复用仍存活的会话重发原任务。成功发出返回 true（保留 sessionNodes 映射）。 */
async function retryAgentNode(
  sessionId: string,
  ref: { runId: string; nodeId: string },
  turnStatus: string,
  summary: string,
  attempts: number,
): Promise<boolean> {
  const db = getDb();
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
  const session = sessions[0];
  if (!session || session.state === 'dead') {
    return false;
  }
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, ref.runId)).limit(1);
  const defRows = runRows[0]
    ? await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, runRows[0].defId)).limit(1)
    : [];
  if (!runRows[0] || !defRows[0]) {
    return false;
  }
  const node = parseDef(defRows[0].graph).nodes.find((n) => n.id === ref.nodeId);
  if (!node || node.type !== 'agent') {
    return false;
  }
  try {
    await callRunner(session.machineId, 'session.send', {
      sessionId,
      text: substitute((node as AgentNode).prompt, runRows[0].context as RunContext),
    });
  } catch {
    return false;
  }
  agentAttempts.set(`${ref.runId}:${ref.nodeId}`, attempts + 1);
  await publish({
    type: 'run.node.retry',
    runId: ref.runId,
    sessionId,
    payload: { nodeId: ref.nodeId, attempt: attempts + 1, max: MAX_AGENT_RETRIES, reason: turnStatus !== 'completed' ? `turn ${turnStatus}` : 'transient error', detail: summary.slice(0, 200) },
  });
  console.log(`[engine] retry agent node ${ref.nodeId} (attempt ${attempts + 1}/${MAX_AGENT_RETRIES}) run ${ref.runId}`);
  return true;
}

/** 从 run 的 def 里取某 agent 节点定义 */
async function loadAgentNode(runId: string, nodeId: string): Promise<AgentNode | undefined> {
  const db = getDb();
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
  if (!runRows[0]) {
    return undefined;
  }
  const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, runRows[0].defId)).limit(1);
  if (!defRows[0]) {
    return undefined;
  }
  const node = parseDef(defRows[0].graph).nodes.find((n) => n.id === nodeId);
  return node?.type === 'agent' ? node : undefined;
}

/** 评审结论解析：优先看显式 VERDICT 行，回落表情/关键词 */
export function verdictChangesRequested(summary: string): boolean {
  if (/VERDICT:\s*CHANGES_REQUESTED/i.test(summary)) {
    return true;
  }
  if (/VERDICT:\s*LGTM/i.test(summary)) {
    return false;
  }
  return (
    /(🔧|建议改进|需改进|需要修|CHANGES[_ ]?REQUESTED|request[- ]?changes)/i.test(summary) &&
    !/(✅\s*LGTM|\/lgtm)/i.test(summary)
  );
}

/** 评审→返工核心：把评审意见回灌 target(实现)会话让其改，重置 review→pending、target→running、
 *  下游 gate→pending（并作废其待批审批）。达轮次上限或实现会话已死则返回 false（放行/交人工）。
 *  既服务 in-run 返工闭环，也服务 reconciler 自动补偿。 */
async function triggerRevision(
  runId: string,
  reviewNodeId: string,
  targetNodeId: string,
  reviewSummary: string,
  maxRounds: number,
): Promise<boolean> {
  const db = getDb();
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) {
    return false;
  }
  const context = run.context as RunContext;
  const rounds = context.reviseRounds ?? {};
  const round = rounds[reviewNodeId] ?? 0;
  if (round >= maxRounds) {
    return false; // 返工轮次耗尽（计数持久化在 context，重启后仍守上限），交人工
  }
  const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
  if (!defRows[0]) {
    return false;
  }
  const def = parseDef(defRows[0].graph);
  const implNode = def.nodes.find((n) => n.id === targetNodeId);
  if (implNode?.type !== 'agent') {
    return false;
  }
  const states = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
  const target = states.find((s) => s.nodeId === targetNodeId);
  const feedback = `SE 评审判定「需改进」。请严格按下面的评审意见修改代码，然后 commit 并 push 到当前分支（同一个 PR，不要新建分支/PR）。改完简要说明你改了哪些点。\n\n===== 评审意见 =====\n${reviewSummary.slice(0, 4000)}`;

  // 实现会话活着 → 回灌返工意见；死了/丢了 → 在原 worktree 重开一个会话继续返工（loop 抗会话丢失）
  const existing = target?.sessionId
    ? (await db.select().from(schema.sessions).where(eq(schema.sessions.id, target.sessionId)).limit(1))[0]
    : undefined;
  let sessionId: string;
  let respawned = false;
  if (existing && existing.state !== 'dead') {
    try {
      await callRunner(existing.machineId, 'session.send', { sessionId: existing.id, text: feedback });
    } catch {
      return false;
    }
    sessionId = existing.id;
  } else {
    const cwd = context.vars.cwd;
    const machineId = await machineForRun(runId);
    if (!machineId || !cwd || !existsSync(cwd)) {
      return false; // 无处重开（worktree 不在/无机器）→ 交人工
    }
    try {
      const spawned = await spawnSession({
        machineId,
        cwd,
        prompt: `${substitute(implNode.prompt, context)}\n\n===== SE 评审要求返工（在当前分支同一 PR 上改） =====\n${reviewSummary.slice(0, 4000)}`,
        agent: implNode.cli,
        model: implNode.model,
        role: implNode.role,
        runId,
        nodeId: targetNodeId,
        meta: { permissionMode: implNode.permissionMode, effort: implNode.effort },
      });
      sessionId = spawned.sessionId;
      respawned = true;
    } catch {
      return false;
    }
  }

  // 持久化轮次 + 状态回退：target→running（重登记会话）、评审→pending、下游 gate→pending 作废审批
  rounds[reviewNodeId] = round + 1;
  context.reviseRounds = rounds;
  await db.update(schema.workflowRuns).set({ context }).where(eq(schema.workflowRuns.id, runId));
  sessionNodes.set(sessionId, { runId, nodeId: targetNodeId });
  await db
    .update(schema.nodeStates)
    .set({ status: 'running', sessionId, updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, targetNodeId)));
  await db
    .update(schema.nodeStates)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, reviewNodeId)));
  const downstreamGates = def.edges
    .filter(([from]) => from === reviewNodeId)
    .map(([, to]) => to)
    .filter((id) => def.nodes.find((n) => n.id === id)?.type === 'gate');
  for (const g of downstreamGates) {
    await db
      .update(schema.nodeStates)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, g)));
    const expired = await db
      .update(schema.approvals)
      .set({ status: 'expired' })
      .where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.nodeId, g), eq(schema.approvals.status, 'pending')))
      .returning({ id: schema.approvals.id });
    for (const ap of expired) {
      await publish({ type: 'approval.decided', runId, payload: { approvalId: ap.id, status: 'expired', decidedBy: 'engine:revising' } });
    }
    await publishNodeState(runId, g, 'pending', { reason: 'revising' });
  }
  await publish({ type: 'run.node.revise', runId, payload: { reviewNode: reviewNodeId, target: targetNodeId, round: round + 1, max: maxRounds, respawned } });
  await publishNodeState(runId, targetNodeId, 'running', { revise: round + 1 });
  await publishNodeState(runId, reviewNodeId, 'pending', { revise: round + 1 });
  console.log(`[engine] revise round ${round + 1}/${maxRounds}: ${targetNodeId} ← review ${reviewNodeId} (run ${runId})${respawned ? ' [respawned]' : ''}`);
  scheduleTick(runId);
  return true;
}

/** 某节点是否是「评审」节点（有 reviseLoop 配置，或角色 SE） */
function isReviewNode(node: AgentNode): boolean {
  return Boolean(node.reviseLoop) || node.role === 'SE';
}

/** reviseLoop 的 target（缺省取该评审节点在 DAG 上游的第一个 agent 节点，通常是 implement） */
function reviseTargetOf(def: WorkflowDef, node: AgentNode): string | undefined {
  if (node.reviseLoop) {
    return node.reviseLoop.target;
  }
  return depsOf(def, node.id).find((d) => {
    const n = def.nodes.find((x) => x.id === d);
    return n?.type === 'agent';
  });
}

/** 自动返工补偿：扫描停在人工门的 run，若评审节点判「需改进」却没返工（如返工闭环上线前建的、
 *  或评审在到门后才落地），自动触发返工——让「按评审意见修好」全程无需人工重跑。 */
async function reconcileRevisions(): Promise<void> {
  const db = getDb();
  const runs = await db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.status, 'waiting_human'));
  for (const run of runs) {
    const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
    if (!defRows[0]) {
      continue;
    }
    const def = parseDef(defRows[0].graph);
    const states = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, run.id));
    for (const node of def.nodes) {
      if (node.type !== 'agent' || !isReviewNode(node)) {
        continue;
      }
      const st = states.find((s) => s.nodeId === node.id);
      if (st?.status !== 'done') {
        continue;
      }
      const summary = ((st.output as { summary?: string } | null)?.summary) ?? '';
      if (!verdictChangesRequested(summary)) {
        continue;
      }
      const target = reviseTargetOf(def, node);
      if (!target) {
        continue;
      }
      const maxRounds = node.reviseLoop?.maxRounds ?? 2;
      const fired = await triggerRevision(run.id, node.id, target, summary, maxRounds).catch(() => false);
      if (fired) {
        console.log(`[engine] reconcile: auto-revise run ${run.id} node ${node.id} → ${target}`);
      }
    }
  }
}

// ---------- 事件订阅与恢复 ----------

export function startEngine(): void {
  bus.on('event', (evt: { type: string; sessionId?: string; payload: unknown }) => {
    if (!evt.sessionId) {
      return;
    }

    // 会话死亡兜底：agent 节点→失败；会议参与者→弃权，仲裁人→reject
    if (evt.type === 'session.state' && (evt.payload as { state?: string })?.state === 'dead') {
      const meetingRef = meetingSessions.get(evt.sessionId);
      if (meetingRef) {
        void onMeetingSessionDone(evt.sessionId, meetingRef).catch((err) =>
          console.error('[engine] meeting dead-session handling failed:', err),
        );
        return;
      }
      if (sessionNodes.has(evt.sessionId)) {
        void completeAgentNode(evt.sessionId, 'failed');
      }
      return;
    }

    if (evt.type !== 'session.message') {
      return;
    }
    const envelope = evt.payload as SessionEnvelope;
    if (envelope?.ev?.t !== 'turn-end') {
      return;
    }
    const meetingRef = meetingSessions.get(evt.sessionId);
    if (meetingRef) {
      void onMeetingSessionDone(evt.sessionId, meetingRef).catch((err) =>
        console.error('[engine] meeting session handling failed:', err),
      );
      return;
    }
    if (sessionNodes.has(evt.sessionId)) {
      void completeAgentNode(evt.sessionId, envelope.ev.status);
    }
  });

  // 安全网：周期性 re-tick 活跃 run（防漏事件）
  setInterval(() => {
    void (async () => {
      const db = getDb();
      const active = await db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(inArray(schema.workflowRuns.status, ['running', 'waiting_human']));
      for (const run of active) {
        scheduleTick(run.id);
      }
    })().catch(() => {});
  }, 30_000).unref();

  // 自动返工补偿：周期性把「停在人工门却带未处理 CHANGES_REQUESTED 评审」的 run 自动打回返工
  setInterval(() => {
    void reconcileRevisions().catch((err) => console.error('[engine] reconcile revisions failed:', err));
  }, 60_000).unref();
}

/** boot 恢复：重建索引，补查引擎宕机期间已完成的会话 */
export async function resumeActiveRuns(): Promise<void> {
  const db = getDb();
  const active = await db
    .select()
    .from(schema.workflowRuns)
    .where(inArray(schema.workflowRuns.status, ['running', 'waiting_human']));
  for (const run of active) {
    const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
    const def = defRows[0] ? parseDef(defRows[0].graph) : null;
    const states = await db
      .select()
      .from(schema.nodeStates)
      .where(and(eq(schema.nodeStates.runId, run.id), eq(schema.nodeStates.status, 'running')));
    for (const st of states) {
      // 会议状态只在内存：重启即失败（明确标注，M3 已知限制）
      if (def?.nodes.find((n) => n.id === st.nodeId)?.type === 'meeting') {
        await db
          .update(schema.nodeStates)
          .set({ status: 'failed', output: { error: '引擎重启导致会议中断（会议状态暂不持久化）' }, updatedAt: new Date() })
          .where(and(eq(schema.nodeStates.runId, run.id), eq(schema.nodeStates.nodeId, st.nodeId)));
        continue;
      }
      if (!st.sessionId) {
        continue;
      }
      sessionNodes.set(st.sessionId, { runId: run.id, nodeId: st.nodeId });
      // 宕机期间已 turn-end？
      const rows = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, st.sessionId), eq(schema.events.type, 'session.message')))
        .orderBy(desc(schema.events.seq))
        .limit(20);
      for (const row of rows) {
        const envelope = row.payload as SessionEnvelope;
        if (envelope?.ev?.t === 'turn-end') {
          void completeAgentNode(st.sessionId, envelope.ev.status);
          break;
        }
      }
    }
    scheduleTick(run.id);
  }
  console.log(`[engine] resumed ${active.length} active run(s)`);
}
