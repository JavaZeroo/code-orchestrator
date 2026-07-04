/**
 * 工作流引擎（M2）：事件驱动的薄状态机，设计文档 §7。
 * - startRun：建 run + 全量 node_states(pending)，触发首次 tick
 * - tick：按 DAG 就绪判定执行节点（按 runId 串行化，幂等）
 * - agent 节点：挑机器 → spawn 会话 → 监听该会话 turn-end → 捕获输出进 context.outputs
 * - gate 节点：建 kind=gate 审批，挂起（可挂数天）；决议后恢复
 * - 崩溃恢复：boot 时重建 会话→节点 索引，补查漏掉的 turn-end
 * M2 仅支持 agent | gate 节点；其余类型在 startRun 拒绝。
 */

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  workflowDefSchema,
  type AgentNode,
  type ApprovalDecision,
  type GateNode,
  type MeetingNode,
  type SessionEnvelope,
  type WorkflowDef,
} from '@co/protocol';
import { getDb, schema } from '../db/index';
import { bus, publish } from '../events';
import { listMachines } from '../ws/runnerHub';
import { spawnSession, SpawnError } from '../services/spawn';

type RunContext = { vars: Record<string, string>; outputs: Record<string, string> };
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

export async function startRun(defId: string, vars: Record<string, string>): Promise<string> {
  const db = getDb();
  const defRows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, defId)).limit(1);
  const defRow = defRows[0];
  if (!defRow) {
    throw new EngineError(404, `workflow not found: ${defId}`);
  }
  const def = parseDef(defRow.graph);
  const unsupported = def.nodes.filter((n) => n.type !== 'agent' && n.type !== 'gate' && n.type !== 'meeting');
  if (unsupported.length > 0) {
    throw new EngineError(400, `当前支持 agent|gate|meeting 节点，含不支持类型: ${unsupported.map((n) => `${n.id}(${n.type})`).join(', ')}`);
  }

  const runId = createId();
  const context: RunContext = { vars: { ...(def.vars ?? {}), ...vars }, outputs: {} };
  await db.insert(schema.workflowRuns).values({ id: runId, defId, status: 'running', context });
  await db
    .insert(schema.nodeStates)
    .values(def.nodes.map((n) => ({ runId, nodeId: n.id, status: 'pending' as const })));
  await publish({ type: 'run.started', runId, payload: { defId, name: def.name, vars: context.vars } });
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
      await execGate(runId, node);
    } else if (node.type === 'meeting') {
      await execMeeting(runId, node, context);
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
  const online = listMachines();
  if (selector?.id) {
    return online.some((m) => m.id === selector.id) ? selector.id : null;
  }
  const labels = selector?.labels ?? [];
  const match = online.find((m) => labels.every((l) => m.labels.includes(l)));
  return match?.id ?? null;
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
    await fail(`没有匹配的在线机器（selector: ${JSON.stringify(node.machine ?? {})}）`);
    return;
  }
  if (!cwdTpl) {
    await fail(`节点未指定 cwd 且运行时 vars.cwd 缺失`);
    return;
  }

  try {
    const { sessionId } = await spawnSession({
      machineId,
      cwd: substitute(cwdTpl, context),
      prompt: substitute(node.prompt, context),
      model: node.model,
      role: node.role,
      runId,
      nodeId: node.id,
      meta: node.role ? { appendSystemPrompt: `你在工作流中承担「${node.role}」角色。` } : undefined,
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

async function execGate(runId: string, node: GateNode): Promise<void> {
  const db = getDb();
  const approvalId = createId();
  await db.insert(schema.approvals).values({
    id: approvalId,
    kind: 'gate',
    runId,
    nodeId: node.id,
    title: node.title ?? `Gate: ${node.id}`,
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
    payload: { id: approvalId, kind: 'gate', runId, nodeId: node.id, title: node.title ?? node.id, payload: { approvers: node.approvers }, requestedAt: Date.now() },
  });
  await publishNodeState(runId, node.id, 'waiting_human', { approvalId });
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
  const machineId = pickMachine(undefined);
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
    await fail('没有在线机器可用于会议参与者');
    return;
  }

  const key = meetingKey(runId, node.id);
  const state: MeetingState = {
    runId,
    nodeId: node.id,
    node,
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
      title: `会议仲裁：${state.node.title ?? state.nodeId}`,
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
      payload: { id: approvalId, kind: 'gate', runId: state.runId, nodeId: state.nodeId, title: `会议仲裁：${state.node.title ?? state.nodeId}`, payload: { minutes }, requestedAt: Date.now() },
    });
    await publishNodeState(state.runId, state.nodeId, 'waiting_human', { phase: 'arbitrate' });
    await writeMeetingRecord(state, 'human-pending', minutes);
    meetings.delete(meetingKey(state.runId, state.nodeId));
    scheduleTick(state.runId);
    return;
  }

  // 模型仲裁
  const machineId = pickMachine(undefined);
  if (!machineId) {
    await finishMeeting(state, 'reject', '仲裁失败：没有在线机器');
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

/** agent 输出中的 gitcode PR URL → 自动登记 forge_ref（M3 门禁回流入口） */
async function autoRegisterForgeRefs(summary: string, ref: { runId: string; nodeId: string }, sessionId: string): Promise<void> {
  const db = getDb();
  const seen = new Set<string>();
  for (const m of summary.matchAll(/gitcode\.com\/([\w.-]+\/[\w.-]+)\/(?:merge_requests|pulls)\/(\d+)/g)) {
    const repo = m[1]!;
    const number = Number(m[2]!);
    const dedupeKey = `${repo}#${number}`;
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
      payload: { repo, number, nodeId: ref.nodeId },
    });
  }
}

async function completeAgentNode(sessionId: string, turnStatus: string): Promise<void> {
  const ref = sessionNodes.get(sessionId);
  if (!ref) {
    return;
  }
  sessionNodes.delete(sessionId);
  const db = getDb();

  const summary = await lastAgentText(sessionId);
  await autoRegisterForgeRefs(summary, ref, sessionId);

  const ok = turnStatus === 'completed';
  await db
    .update(schema.nodeStates)
    .set({ status: ok ? 'done' : 'failed', output: { summary, turnStatus }, updatedAt: new Date() })
    .where(and(eq(schema.nodeStates.runId, ref.runId), eq(schema.nodeStates.nodeId, ref.nodeId)));

  // 输出写进 run context 供下游模板引用
  const runRows = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, ref.runId)).limit(1);
  if (runRows[0]) {
    const context = runRows[0].context as RunContext;
    context.outputs[ref.nodeId] = summary;
    await db.update(schema.workflowRuns).set({ context }).where(eq(schema.workflowRuns.id, ref.runId));
  }

  await publishNodeState(ref.runId, ref.nodeId, ok ? 'done' : 'failed', { sessionId });
  scheduleTick(ref.runId);
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
