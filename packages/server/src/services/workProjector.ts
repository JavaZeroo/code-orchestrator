/**
 * Work-Item 投影器（CQRS 读模型）：订阅事件总线，把事件映射成带血缘 + 生命周期的 work_items 树。
 * 事件日志（events 表）是真相源；work_items 是可查可管的物化投影，可整表从 events 重放重建。
 * key 是自然键（幂等 upsert）；parentKey 解析成 parentId 形成树。
 */

import { createId } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { getDb, hasDb, schema } from '../db/index';
import { bus, type OrchEvent } from '../events';

type Status = 'pending' | 'active' | 'waiting_human' | 'blocked' | 'done' | 'failed' | 'cancelled';

interface Upsert {
  type: string;
  title?: string;
  status?: Status;
  owner?: string;
  parentKey?: string;
  refs?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ended?: boolean;
  /** 只在已存在时更新，不新建（如 approval.decided 不该为从未投影的 tool 审批建根） */
  updateOnly?: boolean;
}

const NODE_STATUS: Record<string, Status> = {
  pending: 'pending',
  running: 'active',
  waiting_human: 'waiting_human',
  done: 'done',
  failed: 'failed',
  skipped: 'cancelled',
};

async function resolveParentId(parentKey?: string): Promise<string | undefined> {
  if (!parentKey) {
    return undefined;
  }
  const rows = await getDb().select({ id: schema.workItems.id }).from(schema.workItems).where(eq(schema.workItems.key, parentKey)).limit(1);
  return rows[0]?.id;
}

/** 幂等 upsert：按 key 建/改；refs/meta 合并；仅在给出时覆盖字段 */
async function upsert(key: string, patch: Upsert): Promise<void> {
  const db = getDb();
  const parentId = await resolveParentId(patch.parentKey);
  const existing = (await db.select().from(schema.workItems).where(eq(schema.workItems.key, key)).limit(1))[0];
  const now = new Date();
  if (existing) {
    await db
      .update(schema.workItems)
      .set({
        title: patch.title ?? existing.title,
        status: patch.status ?? (existing.status as Status),
        owner: patch.owner ?? existing.owner,
        parentId: parentId ?? existing.parentId,
        refs: { ...(existing.refs ?? {}), ...(patch.refs ?? {}) },
        meta: { ...(existing.meta ?? {}), ...(patch.meta ?? {}) },
        endedAt: patch.ended ? now : existing.endedAt,
        updatedAt: now,
      })
      .where(eq(schema.workItems.key, key));
  } else if (!patch.updateOnly) {
    await db
      .insert(schema.workItems)
      .values({
        id: createId(),
        key,
        type: patch.type,
        title: patch.title,
        status: patch.status ?? 'active',
        owner: patch.owner,
        parentId,
        refs: patch.refs ?? {},
        meta: patch.meta ?? {},
        endedAt: patch.ended ? now : null,
      })
      .onConflictDoNothing({ target: schema.workItems.key });
  }
}

/** 单独回填父指针（用于事件乱序时的血缘补链，如 run.started 先于 requirement.triggered） */
async function setParent(childKey: string, parentKey: string): Promise<void> {
  const parentId = await resolveParentId(parentKey);
  if (!parentId) {
    return;
  }
  await getDb().update(schema.workItems).set({ parentId, updatedAt: new Date() }).where(eq(schema.workItems.key, childKey));
}

type P = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? '');

/** 事件 → work_items 投影。纯映射，live 与 replay 共用。 */
export async function applyEvent(evt: OrchEvent): Promise<void> {
  const p = (evt.payload ?? {}) as P;
  const runKey = evt.runId ? `run:${evt.runId}` : undefined;
  switch (evt.type) {
    case 'requirement.triggered': {
      const reqKey = `req:${s(p.triggerId)}:${s(p.issue)}`;
      await upsert(reqKey, {
        type: 'requirement',
        owner: 'pm',
        status: 'active',
        title: `#${s(p.issue)} ${s(p.title)}`,
        refs: { forge: p.forge, repo: p.repo, issue: p.issue, url: p.url, runId: evt.runId },
      });
      if (runKey) {
        await setParent(runKey, reqKey); // run 通常先于本事件出现，回填其父
      }
      break;
    }
    case 'requirement.failed':
      await upsert(`req:${s(p.triggerId)}:${s(p.issue)}`, {
        type: 'requirement',
        owner: 'pm',
        status: 'failed',
        title: `#${s(p.issue)}`,
        refs: { forge: p.forge, repo: p.repo, issue: p.issue, error: p.error },
        ended: true,
      });
      break;
    case 'run.started':
      if (runKey) {
        await upsert(runKey, { type: 'run', status: 'active', title: s(p.name) || 'run', refs: { runId: evt.runId, defId: p.defId } });
      }
      break;
    case 'run.status':
      if (runKey) {
        await upsert(runKey, { type: 'run', status: s(p.status) === 'waiting_human' ? 'waiting_human' : 'active' });
      }
      break;
    case 'run.finished':
      if (runKey) {
        await upsert(runKey, { type: 'run', status: s(p.status) === 'done' ? 'done' : s(p.status) === 'cancelled' ? 'cancelled' : 'failed', ended: true });
      }
      break;
    case 'run.node.state':
      if (runKey) {
        await upsert(`node:${evt.runId}:${s(p.nodeId)}`, {
          type: 'node',
          parentKey: runKey,
          title: s(p.nodeId),
          status: NODE_STATUS[s(p.status)] ?? 'active',
          refs: { runId: evt.runId, nodeId: p.nodeId, sessionId: p.sessionId },
        });
      }
      break;
    case 'run.node.revise':
      await upsert(`node:${evt.runId}:${s(p.reviewNode)}`, { type: 'node', meta: { reviseRound: p.round, reviseMax: p.max } });
      break;
    case 'run.node.retry':
      await upsert(`node:${evt.runId}:${s(p.nodeId)}`, { type: 'node', meta: { retryAttempt: p.attempt } });
      break;
    case 'forge.ref_registered':
      await upsert(`pr:${s(p.forge)}:${s(p.repo)}#${s(p.number)}`, {
        type: 'pr',
        parentKey: `node:${evt.runId}:${s(p.nodeId)}`,
        title: `PR ${s(p.repo)}#${s(p.number)}`,
        status: 'active',
        refs: { forge: p.forge, repo: p.repo, number: p.number, runId: evt.runId, nodeId: p.nodeId },
      });
      break;
    case 'forge.ci':
      await upsert(`pr:${s(p.forge)}:${s(p.repo)}#${s(p.number)}`, { type: 'pr', meta: { ciState: p.state } });
      break;
    case 'forge.pr_state':
      await upsert(`pr:${s(p.forge)}:${s(p.repo)}#${s(p.number)}`, {
        type: 'pr',
        status: s(p.state) === 'merged' ? 'done' : 'cancelled',
        meta: { prState: p.state },
        ended: true,
      });
      break;
    case 'approval.requested': {
      if (s(p.kind) === 'tool') {
        break; // tool 审批是会话级瞬时噪音，不进流程血缘（只投影 gate 人工门）
      }
      // 确保父节点 work-item 先存在（审批事件常早于该节点的 run.node.state），再挂审批
      const nodeKey = p.nodeId && evt.runId ? `node:${evt.runId}:${s(p.nodeId)}` : undefined;
      if (nodeKey) {
        await upsert(nodeKey, { type: 'node', parentKey: runKey, title: s(p.nodeId), refs: { runId: evt.runId, nodeId: p.nodeId } });
      }
      await upsert(`approval:${s(p.id)}`, {
        type: 'approval',
        parentKey: nodeKey ?? runKey,
        title: s(p.title) || '待审批',
        owner: 'human',
        status: 'waiting_human',
        refs: { approvalId: p.id, kind: p.kind, runId: evt.runId, nodeId: p.nodeId },
      });
      break;
    }
    case 'approval.decided':
      // 只更新已投影的（gate）审批；tool 审批从未建，updateOnly 跳过
      await upsert(`approval:${s(p.approvalId)}`, { type: 'approval', status: s(p.status) === 'approved' ? 'done' : 'failed', ended: true, updateOnly: true });
      break;
    default:
      break;
  }
}

let started = false;

/** 订阅事件总线做实时投影 */
export function startWorkProjector(): void {
  if (started || !hasDb()) {
    return;
  }
  started = true;
  bus.on('event', (evt: OrchEvent) => {
    void applyEvent(evt).catch((err) => console.error('[work] project failed:', evt.type, err instanceof Error ? err.message : err));
  });
  console.log('[work] projector started');
}

/** 从 events 表按 seq 顺序重放，重建 work_items（幂等）。boot 时补齐历史。 */
export async function rebuildWorkItems(): Promise<number> {
  if (!hasDb()) {
    return 0;
  }
  const db = getDb();
  const rows = await db.select().from(schema.events).orderBy(asc(schema.events.seq));
  for (const row of rows) {
    await applyEvent({ type: row.type, sessionId: row.sessionId ?? undefined, runId: row.runId ?? undefined, payload: row.payload });
  }
  return rows.length;
}
