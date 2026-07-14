/**
 * 需求录入触发器轮询（task #22，最初愿景的入口）。
 * 慢环 60s：对 enabled 触发器用其 forge adapter 拉 issue，过滤（标签 + 标题）后
 * 未见过的 issue → 起工作流（注入 issue_* 变量），记账到 requirement_intakes（去重 + run 追溯）。
 * 首次启用（lastPolledAt 为空）只建立基线（seeded，不触发），除非 backfill=yes——
 * 避免在已有历史 issue 的仓上一次性刷起大量 run。
 * forge 无关：issue 列表由各 adapter 归一化（NormalizedIssue）。
 */

import { Cron } from 'croner';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { publish } from '../events';
import { EngineError, startRun } from '../engine/engine';
import { getForge, isForgeKind } from './registry';
import { anyForgeToken } from './tokens';
import type { NormalizedIssue } from './types';
import { provisionWorkspace } from './workspace';

const POLL_INTERVAL_MS = 60_000;
/** since 水位回溯缓冲：容忍 server↔forge 时钟偏差，宁可重叠（去重表兜底）也不漏 issue */
const SINCE_BUFFER_MS = 5 * 60_000;

type TriggerRow = typeof schema.requirementTriggers.$inferSelect;
type IntakeRow = typeof schema.requirementIntakes.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;

export interface RecordedIntakeContext {
  intake: Pick<
    IntakeRow,
    | 'id'
    | 'triggerId'
    | 'projectId'
    | 'forge'
    | 'repo'
    | 'issueNumber'
    | 'title'
    | 'author'
    | 'issueUrl'
    | 'runId'
    | 'status'
  >;
  trigger: Pick<TriggerRow, 'id' | 'defId' | 'forge' | 'repo' | 'vars'> & { createdBy?: string | null };
  project?: Pick<ProjectRow, 'id' | 'name' | 'vars'>;
}

export interface RecordedIntakeStartDependencies {
  load(id: string): Promise<RecordedIntakeContext | undefined>;
  claim(id: string): Promise<boolean>;
  getIssue(context: RecordedIntakeContext): Promise<NormalizedIssue>;
  launch(context: RecordedIntakeContext, issue: NormalizedIssue, vars: Record<string, string>): Promise<string>;
  rollback(context: RecordedIntakeContext, error: unknown): Promise<void>;
}

export class RecordedIntakeStartError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** 标签需全含；标题按正则（非法则退化子串）过滤 */
function matches(issue: NormalizedIssue, trigger: TriggerRow): boolean {
  const need = trigger.labels ?? [];
  if (need.length && !need.every((l) => issue.labels.includes(l))) {
    return false;
  }
  const pat = trigger.titlePattern?.trim();
  if (pat) {
    try {
      if (!new RegExp(pat, 'i').test(issue.title)) {
        return false;
      }
    } catch {
      if (!issue.title.toLowerCase().includes(pat.toLowerCase())) {
        return false;
      }
    }
  }
  return true;
}

/** issue 字段 → 工作流变量（agent 节点 prompt 用 {{vars.issue_body}} 等引用） */
export function buildIssueVariables(
  issue: NormalizedIssue,
  trigger: Pick<TriggerRow, 'forge' | 'repo' | 'vars'>,
  project?: { vars: Record<string, string> },
  source: Pick<IntakeRow, 'forge' | 'repo'> = trigger,
): Record<string, string> {
  return {
    ...(project?.vars ?? {}), // 项目级默认（最低优先）
    ...trigger.vars, // 触发器覆盖项目
    forge: source.forge,
    repo: source.repo,
    issue_number: issue.number,
    issue_title: issue.title,
    issue_body: issue.body ?? '',
    issue_url: issue.htmlUrl ?? '',
    issue_author: issue.author ?? '',
  };
}

export async function startRecordedIntakeWithDependencies(
  id: string,
  deps: RecordedIntakeStartDependencies,
): Promise<{ runId: string }> {
  const context = await deps.load(id);
  if (!context) {
    throw new RecordedIntakeStartError(404, `requirement intake not found: ${id}`);
  }
  if (context.intake.runId || !['seeded', 'failed'].includes(context.intake.status)) {
    throw new RecordedIntakeStartError(409, `requirement intake already started or claimed: ${id}`);
  }
  if (!(await deps.claim(id))) {
    throw new RecordedIntakeStartError(409, `requirement intake is already being started: ${id}`);
  }

  try {
    const fresh = await deps.getIssue(context);
    const issue: NormalizedIssue = {
      ...fresh,
      number: context.intake.issueNumber,
      title: fresh.title || context.intake.title || `#${context.intake.issueNumber}`,
      author: fresh.author ?? context.intake.author ?? undefined,
      htmlUrl: fresh.htmlUrl ?? context.intake.issueUrl ?? undefined,
    };
    const vars = buildIssueVariables(issue, context.trigger, context.project, context.intake);
    const runId = await deps.launch(context, issue, vars);
    return { runId };
  } catch (err) {
    await deps.rollback(context, err);
    if (err instanceof RecordedIntakeStartError) {
      throw err;
    }
    if (err instanceof EngineError) {
      throw new RecordedIntakeStartError(err.statusCode, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordedIntakeStartError(502, `requirement intake launch failed: ${message}`);
  }
}

async function launchIssueIntake(
  context: RecordedIntakeContext,
  issue: NormalizedIssue,
  vars: Record<string, string>,
  via?: 'manual',
): Promise<string> {
  const db = getDb();
  const ws = await provisionWorkspace(
    context.intake.forge,
    context.intake.repo,
    context.intake.issueNumber,
    vars.base ?? 'main',
  );
  if (ws) {
    vars.cwd = ws.cwd;
    vars.branch = ws.branch;
  }
  const runId = await startRun(
    context.trigger.defId,
    vars,
    context.intake.projectId ?? undefined,
    async (tx, createdRunId) => {
      const linked = await tx
        .update(schema.requirementIntakes)
        .set({ runId: createdRunId, status: 'started' })
        .where(
          and(
            eq(schema.requirementIntakes.id, context.intake.id),
            eq(schema.requirementIntakes.status, 'starting'),
            isNull(schema.requirementIntakes.runId),
          ),
        )
        .returning({ id: schema.requirementIntakes.id });
      if (!linked[0]) {
        throw new RecordedIntakeStartError(
          409,
          `requirement intake already started or claimed: ${context.intake.id}`,
        );
      }
    },
    context.trigger.createdBy ?? undefined,
  );
  await publish({
    type: 'requirement.triggered',
    runId,
    payload: {
      triggerId: context.trigger.id,
      projectId: context.intake.projectId ?? undefined,
      project: context.project?.name,
      forge: context.intake.forge,
      repo: context.intake.repo,
      issue: context.intake.issueNumber,
      title: issue.title,
      url: issue.htmlUrl,
      ...(via ? { via } : {}),
    },
  });
  return runId;
}

const recordedIntakeDependencies: RecordedIntakeStartDependencies = {
  async load(id) {
    const db = getDb();
    const [intake] = await db
      .select()
      .from(schema.requirementIntakes)
      .where(eq(schema.requirementIntakes.id, id))
      .limit(1);
    if (!intake) {
      return undefined;
    }
    const [trigger] = await db
      .select()
      .from(schema.requirementTriggers)
      .where(eq(schema.requirementTriggers.id, intake.triggerId))
      .limit(1);
    if (!trigger) {
      return undefined;
    }
    const project = intake.projectId
      ? (await db.select().from(schema.projects).where(eq(schema.projects.id, intake.projectId)).limit(1))[0]
      : undefined;
    return { intake, trigger, project };
  },

  async claim(id) {
    const claimed = await getDb()
      .update(schema.requirementIntakes)
      .set({ status: 'starting' })
      .where(
        and(
          eq(schema.requirementIntakes.id, id),
          inArray(schema.requirementIntakes.status, ['seeded', 'failed']),
          isNull(schema.requirementIntakes.runId),
        ),
      )
      .returning({ id: schema.requirementIntakes.id });
    return Boolean(claimed[0]);
  },

  async getIssue(context) {
    const token = await anyForgeToken(context.intake.forge);
    return getForge(context.intake.forge).getIssue(
      context.intake.repo,
      context.intake.issueNumber,
      token,
    );
  },

  launch(context, issue, vars) {
    return launchIssueIntake(context, issue, vars, 'manual');
  },

  async rollback(context, error) {
    const rolledBack = await getDb()
      .update(schema.requirementIntakes)
      .set({ status: 'failed' })
      .where(
        and(
          eq(schema.requirementIntakes.id, context.intake.id),
          eq(schema.requirementIntakes.status, 'starting'),
          isNull(schema.requirementIntakes.runId),
        ),
      )
      .returning({ id: schema.requirementIntakes.id });
    if (!rolledBack[0]) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await publish({
      type: 'requirement.failed',
      payload: {
        triggerId: context.trigger.id,
        projectId: context.intake.projectId ?? undefined,
        forge: context.intake.forge,
        repo: context.intake.repo,
        issue: context.intake.issueNumber,
        error: message,
        via: 'manual',
      },
    });
  },
};

export function startRecordedIntake(id: string): Promise<{ runId: string }> {
  return startRecordedIntakeWithDependencies(id, recordedIntakeDependencies);
}

/** kind=schedule：cron 到点起 run。首轮只立水位不触发；错过多个周期只补一发。 */
async function pollScheduleTrigger(trigger: TriggerRow): Promise<void> {
  const db = getDb();
  const now = new Date();
  const stamp = () =>
    db.update(schema.requirementTriggers).set({ lastPolledAt: now }).where(eq(schema.requirementTriggers.id, trigger.id));
  if (!trigger.schedule) {
    return;
  }
  if (!trigger.lastPolledAt) {
    await stamp(); // 基线：启用后从现在起算，不补历史
    return;
  }
  let due: Date | null;
  try {
    due = new Cron(trigger.schedule).nextRun(trigger.lastPolledAt);
  } catch (err) {
    console.error(`[intake] bad cron "${trigger.schedule}" (trigger ${trigger.id}):`, err instanceof Error ? err.message : err);
    return;
  }
  if (!due || due > now) {
    await stamp();
    return;
  }
  const forgeKind = isForgeKind(trigger.forge) ? trigger.forge : 'gitcode';
  const project = trigger.projectId
    ? (await getDb().select().from(schema.projects).where(eq(schema.projects.id, trigger.projectId)).limit(1))[0]
    : undefined;
  const vars: Record<string, string> = {
    ...(project?.vars ?? {}),
    ...trigger.vars,
    forge: trigger.forge,
    repo: trigger.repo,
    fired_at: due.toISOString(),
  };
  try {
    const ws = await provisionWorkspace(forgeKind, trigger.repo, `sched-${Date.now()}`, vars.base ?? 'main');
    if (ws) {
      vars.cwd = ws.cwd;
      vars.branch = ws.branch;
    }
    const runId = await startRun(trigger.defId, vars, trigger.projectId ?? undefined, undefined, trigger.createdBy ?? undefined);
    await publish({
      type: 'requirement.triggered',
      runId,
      payload: { triggerId: trigger.id, projectId: trigger.projectId ?? undefined, project: project?.name, forge: forgeKind, repo: trigger.repo, schedule: trigger.schedule, firedAt: due.toISOString(), via: 'schedule' },
    });
    console.log(`[intake] schedule ${trigger.schedule} @ ${trigger.repo} → run ${runId}`);
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : err instanceof Error ? err.message : String(err);
    await publish({ type: 'requirement.failed', payload: { triggerId: trigger.id, forge: forgeKind, repo: trigger.repo, schedule: trigger.schedule, error: msg } });
    console.error(`[intake] schedule startRun failed (${trigger.id}):`, msg);
  } finally {
    await stamp();
  }
}

async function pollTrigger(trigger: TriggerRow): Promise<void> {
  if (trigger.kind === 'schedule') {
    return pollScheduleTrigger(trigger);
  }
  const db = getDb();
  const forgeKind = isForgeKind(trigger.forge) ? trigger.forge : 'gitcode';
  const forge = getForge(forgeKind);
  const token = await anyForgeToken(forgeKind);
  // 归属项目：继承其默认 vars（并让 work-item 血缘挂到 project 根下）
  const project = trigger.projectId
    ? (await db.select().from(schema.projects).where(eq(schema.projects.id, trigger.projectId)).limit(1))[0]
    : undefined;

  const since = trigger.lastPolledAt
    ? new Date(trigger.lastPolledAt.getTime() - SINCE_BUFFER_MS).toISOString()
    : undefined;

  let issues: NormalizedIssue[];
  try {
    issues = await forge.listIssues(trigger.repo, { state: 'open', labels: trigger.labels ?? [], since }, token);
  } catch (err) {
    console.error(`[intake] list issues failed ${trigger.forge}:${trigger.repo}:`, err instanceof Error ? err.message : err);
    return;
  }

  // 首轮且未开 backfill：只登记基线，不触发
  const seeding = trigger.lastPolledAt == null && trigger.backfill !== 'yes';
  const matched = issues.filter((i) => matches(i, trigger));

  for (const issue of matched) {
    // 去重：唯一索引 (trigger_id, issue_number) 抢占插入；返回空 = 已见过
    const inserted = await db
      .insert(schema.requirementIntakes)
      .values({
        id: createId(),
        triggerId: trigger.id,
        projectId: trigger.projectId ?? null,
        forge: forgeKind,
        repo: trigger.repo,
        issueNumber: issue.number,
        title: issue.title,
        author: issue.author,
        issueUrl: issue.htmlUrl,
        status: seeding ? 'seeded' : 'starting',
      })
      .onConflictDoNothing({ target: [schema.requirementIntakes.triggerId, schema.requirementIntakes.issueNumber] })
      .returning({ id: schema.requirementIntakes.id });
    const intakeId = inserted[0]?.id;
    if (!intakeId || seeding) {
      continue; // 已见过，或基线仅记录不触发
    }
    try {
      const vars = buildIssueVariables(issue, trigger, project);
      const context: RecordedIntakeContext = {
        intake: {
          id: intakeId,
          triggerId: trigger.id,
          projectId: trigger.projectId ?? null,
          forge: forgeKind,
          repo: trigger.repo,
          issueNumber: issue.number,
          title: issue.title,
          author: issue.author ?? null,
          issueUrl: issue.htmlUrl ?? null,
          runId: null,
          status: 'starting',
        },
        trigger,
        project,
      };
      const runId = await launchIssueIntake(context, issue, vars);
      console.log(`[intake] ${trigger.repo}#${issue.number} → run ${runId}`);
    } catch (err) {
      const msg = err instanceof EngineError ? err.message : err instanceof Error ? err.message : String(err);
      await db
        .update(schema.requirementIntakes)
        .set({ status: 'failed' })
        .where(
          and(
            eq(schema.requirementIntakes.id, intakeId),
            eq(schema.requirementIntakes.status, 'starting'),
            isNull(schema.requirementIntakes.runId),
          ),
        );
      await publish({
        type: 'requirement.failed',
        payload: { triggerId: trigger.id, forge: forgeKind, repo: trigger.repo, issue: issue.number, error: msg },
      });
      console.error(`[intake] startRun failed for ${trigger.repo}#${issue.number}:`, msg);
    }
  }

  await db
    .update(schema.requirementTriggers)
    .set({ lastPolledAt: new Date() })
    .where(eq(schema.requirementTriggers.id, trigger.id));
  if (seeding && matched.length) {
    await publish({ type: 'requirement.seeded', payload: { triggerId: trigger.id, repo: trigger.repo, count: matched.length } });
    console.log(`[intake] seeded ${matched.length} existing issue(s) for ${trigger.repo} (baseline, no run)`);
  }
}

let polling = false;

export async function pollIntakesOnce(): Promise<number> {
  if (polling) {
    return 0;
  }
  polling = true;
  try {
    const db = getDb();
    const triggers = await db
      .select()
      .from(schema.requirementTriggers)
      .where(eq(schema.requirementTriggers.enabled, 'yes'));
    for (const t of triggers) {
      await pollTrigger(t);
    }
    return triggers.length;
  } finally {
    polling = false;
  }
}

export function startIntakePoller(): void {
  setInterval(() => {
    void pollIntakesOnce().catch((err) => console.error('[intake] poll cycle failed:', err));
  }, POLL_INTERVAL_MS).unref();
  console.log(`[intake] requirement trigger poller started (interval ${POLL_INTERVAL_MS / 1000}s)`);
}
