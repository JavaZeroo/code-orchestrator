/**
 * 门禁回流轮询器（设计 §8.3，语义照 agent-orchestrator 的 lifecycle/reactions）。
 * 快环 30s：对活跃 forge_refs 轮询 PR（一个 GET 拿 labels+mergeable_state）+ 评论增量，
 * 变化 → forge.* 事件 → nudge（按原因去重、每类封顶 3 次）→ session.send 注入负责会话。
 * CI 状态源自 PR 标签（gitcode 无 commit status API，见调研报告 §5）。
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { publish } from '../events';
import { callRunner } from '../ws/runnerHub';
import { gitcode, type PullComment, type PullInfo } from './gitcode';
import { anyForgeToken } from './tokens';

const POLL_INTERVAL_MS = 30_000;
const NUDGE_CAP = 3;

type ForgeRefRow = typeof schema.forgeRefs.$inferSelect;

interface Snapshot {
  ciState?: string;
  conflictPassed?: boolean;
  lastCommentId?: number;
  labels?: string[];
  prState?: string;
}

function ciStateFromLabels(labels: string[]): string {
  if (labels.includes('ci-pipeline-passed')) {
    return 'passed';
  }
  if (labels.includes('ci-pipeline-failed') || labels.includes('pr-ci-fail')) {
    return 'failed';
  }
  if (labels.includes('ci-pipeline-running') || labels.includes('SC-RUNNING')) {
    return 'running';
  }
  return 'unknown';
}

function isBot(login: string): boolean {
  return /bot|ci|compass/i.test(login);
}

async function nudge(ref: ForgeRefRow, counts: Record<string, number>, kind: string, message: string): Promise<void> {
  const used = counts[kind] ?? 0;
  if (used >= NUDGE_CAP) {
    await publish({ type: 'nudge.suppressed', runId: ref.runId ?? undefined, payload: { ref: ref.id, kind } });
    return;
  }

  if (!ref.sessionId) {
    await publish({ type: 'nudge.skipped', runId: ref.runId ?? undefined, payload: { ref: ref.id, kind, reason: 'no session bound' } });
    return;
  }
  const db = getDb();
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.id, ref.sessionId)).limit(1);
  const session = sessions[0];
  if (!session || session.state === 'dead') {
    await publish({
      type: 'nudge.skipped',
      sessionId: ref.sessionId,
      runId: ref.runId ?? undefined,
      payload: { ref: ref.id, kind, reason: 'session dead' },
    });
    return;
  }
  const text = `[gitcode ${ref.repo} !${ref.number}] ${message}`;
  try {
    await callRunner(session.machineId, 'session.send', { sessionId: session.id, text });
    counts[kind] = used + 1; // 只有真实送达才消耗封顶计数
    await publish({
      type: 'nudge.sent',
      sessionId: session.id,
      runId: ref.runId ?? undefined,
      payload: { ref: ref.id, kind, attempt: counts[kind], message },
    });
  } catch (err) {
    console.error(`[forge] nudge send failed (${ref.repo}!${ref.number}):`, err instanceof Error ? err.message : err);
  }
}

async function pollRef(ref: ForgeRefRow): Promise<void> {
  const db = getDb();
  const token = await anyForgeToken();
  const old = (ref.snapshot ?? {}) as Snapshot;
  const counts = { ...(ref.nudgeCounts ?? {}) };

  let pr: PullInfo;
  let comments: PullComment[];
  try {
    pr = await gitcode.getPull(ref.repo, ref.number, token);
    comments = await gitcode.listPullComments(ref.repo, ref.number, token);
  } catch (err) {
    console.error(`[forge] poll failed ${ref.repo}!${ref.number}:`, err instanceof Error ? err.message : err);
    return;
  }

  const labels = pr.labels.map((l) => l.name);
  const next: Snapshot = {
    ciState: ciStateFromLabels(labels),
    conflictPassed: pr.mergeable_state?.conflict_passed,
    lastCommentId: old.lastCommentId ?? 0,
    labels,
    prState: pr.state,
  };

  // PR 终态 → 停止跟踪
  if (pr.state === 'merged' || pr.state === 'closed') {
    if (old.prState !== pr.state) {
      await publish({
        type: 'forge.pr_state',
        runId: ref.runId ?? undefined,
        sessionId: ref.sessionId ?? undefined,
        payload: { repo: ref.repo, number: ref.number, state: pr.state },
      });
    }
    await db
      .update(schema.forgeRefs)
      .set({ active: 'no', snapshot: next as Record<string, unknown>, ciStatus: next.ciState, updatedAt: new Date() })
      .where(eq(schema.forgeRefs.id, ref.id));
    return;
  }

  // CI 标签状态迁移
  if (next.ciState !== old.ciState) {
    await publish({
      type: 'forge.ci',
      runId: ref.runId ?? undefined,
      sessionId: ref.sessionId ?? undefined,
      payload: { repo: ref.repo, number: ref.number, state: next.ciState, labels },
    });
    if (next.ciState === 'failed') {
      const reasons = pr.mergeable_state?.reason ? ` 未过项: ${JSON.stringify(pr.mergeable_state.reason)}` : '';
      await nudge(
        ref,
        counts,
        'ci_failed',
        `门禁失败（标签: ${labels.filter((l) => /ci|fail/i.test(l)).join(', ')}）。${reasons} 请查看 PR 中 bot 评论定位失败 stage，修复后 push；codecheck 通过后评论 /retest 触发完整流水线。`,
      );
    }
  }

  // 冲突检测
  if (next.conflictPassed === false && old.conflictPassed !== false) {
    await publish({
      type: 'forge.conflict',
      runId: ref.runId ?? undefined,
      sessionId: ref.sessionId ?? undefined,
      payload: { repo: ref.repo, number: ref.number },
    });
    await nudge(ref, counts, 'conflict', '与目标分支存在冲突。请拉取最新目标分支 rebase 解决冲突后强推。');
  }

  // 评论增量（首轮只建立水位，不为存量评论发事件/nudge）
  const lastId = old.lastCommentId ?? 0;
  const fresh = lastId === 0 ? [] : comments.filter((c) => c.id > lastId).sort((a, b) => a.id - b.id);
  for (const c of fresh) {
    next.lastCommentId = Math.max(next.lastCommentId ?? 0, c.id);
    const author = c.user?.login ?? c.user?.name ?? 'unknown';
    await publish({
      type: 'forge.review_comment',
      runId: ref.runId ?? undefined,
      sessionId: ref.sessionId ?? undefined,
      payload: { repo: ref.repo, number: ref.number, commentId: c.id, author, commentType: c.comment_type, excerpt: c.body.slice(0, 300) },
    });
    // 可执行评审意见：行级评论，或人类的普通评论
    const actionable = c.comment_type === 'diff_comment' || !isBot(author);
    if (actionable) {
      await nudge(ref, counts, 'review', `${author} 的评审意见（${c.comment_type ?? 'comment'}）：\n${c.body.slice(0, 500)}\n请处理并回复；行级意见解决后标记 resolve。`);
    }
  }
  if (fresh.length === 0) {
    next.lastCommentId = lastId;
  }
  // 首轮只建立基线，不为存量评论发 nudge
  if (lastId === 0 && comments.length > 0) {
    next.lastCommentId = Math.max(...comments.map((c) => c.id));
  }

  await db
    .update(schema.forgeRefs)
    .set({
      snapshot: next as Record<string, unknown>,
      ciStatus: next.ciState,
      nudgeCounts: counts,
      updatedAt: new Date(),
    })
    .where(eq(schema.forgeRefs.id, ref.id));
}

let polling = false;

export async function pollOnce(): Promise<number> {
  if (polling) {
    return 0;
  }
  polling = true;
  try {
    const db = getDb();
    const refs = await db
      .select()
      .from(schema.forgeRefs)
      .where(eq(schema.forgeRefs.active, 'yes'));
    for (const ref of refs.filter((r) => r.kind === 'pr')) {
      await pollRef(ref);
    }
    return refs.length;
  } finally {
    polling = false;
  }
}

export function startForgePoller(): void {
  setInterval(() => {
    void pollOnce().catch((err) => console.error('[forge] poll cycle failed:', err));
  }, POLL_INTERVAL_MS).unref();
  console.log(`[forge] poller started (interval ${POLL_INTERVAL_MS / 1000}s)`);
}
