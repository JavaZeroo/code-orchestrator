/**
 * 需求录入触发器的配置与需求列表（task #22）。
 * - 触发器 CRUD：绑定 forge repo + 工作流 + 过滤条件（标签/标题）+ 静态变量
 * - 需求列表：命中触发器的 issue → run 追溯（intake 表 join run 状态）
 * - 手动轮询：调试用，立即跑一轮
 */

import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { count, desc, eq, max, sql } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { pollIntakesOnce } from '../forge/intake';

const createSchema = z.object({
  forge: z.enum(['gitcode', 'github']),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式: owner/repo'),
  defId: z.string().min(1),
  labels: z.array(z.string()).default([]),
  titlePattern: z.string().optional(),
  vars: z.record(z.string(), z.string()).default({}),
  backfill: z.enum(['yes', 'no']).default('no'),
});

const patchSchema = z.object({
  defId: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  titlePattern: z.string().nullable().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  enabled: z.enum(['yes', 'no']).optional(),
  backfill: z.enum(['yes', 'no']).optional(),
});

export async function registerTriggerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/triggers', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const db = getDb();
    const def = await db.select({ id: schema.workflowDefs.id }).from(schema.workflowDefs).where(eq(schema.workflowDefs.id, body.defId)).limit(1);
    if (!def[0]) {
      void reply.code(400);
      return { error: `工作流不存在: ${body.defId}` };
    }
    const id = createId();
    await db.insert(schema.requirementTriggers).values({
      id,
      forge: body.forge,
      repo: body.repo,
      defId: body.defId,
      labels: body.labels,
      titlePattern: body.titlePattern,
      vars: body.vars,
      backfill: body.backfill,
      createdBy: req.user?.id,
    });
    void reply.code(201);
    return { id };
  });

  app.get('/api/triggers', async () => {
    const db = getDb();
    // 每个触发器的命中统计：intake 行数 + 最近命中时间
    const intakeAgg = db
      .select({
        triggerId: schema.requirementIntakes.triggerId,
        intakeCount: count().as('intake_count'),
        lastIntakeAt: max(schema.requirementIntakes.createdAt).as('last_intake_at'),
      })
      .from(schema.requirementIntakes)
      .groupBy(schema.requirementIntakes.triggerId)
      .as('intake_agg');
    const rows = await db
      .select({
        id: schema.requirementTriggers.id,
        forge: schema.requirementTriggers.forge,
        repo: schema.requirementTriggers.repo,
        defId: schema.requirementTriggers.defId,
        defName: schema.workflowDefs.name,
        labels: schema.requirementTriggers.labels,
        titlePattern: schema.requirementTriggers.titlePattern,
        vars: schema.requirementTriggers.vars,
        backfill: schema.requirementTriggers.backfill,
        enabled: schema.requirementTriggers.enabled,
        lastPolledAt: schema.requirementTriggers.lastPolledAt,
        createdAt: schema.requirementTriggers.createdAt,
        intakeCount: sql<number>`coalesce(${intakeAgg.intakeCount}, 0)`.mapWith(Number),
        lastIntakeAt: intakeAgg.lastIntakeAt,
      })
      .from(schema.requirementTriggers)
      .leftJoin(schema.workflowDefs, eq(schema.requirementTriggers.defId, schema.workflowDefs.id))
      .leftJoin(intakeAgg, eq(schema.requirementTriggers.id, intakeAgg.triggerId))
      .orderBy(desc(schema.requirementTriggers.createdAt))
      .limit(100);
    return { triggers: rows };
  });

  app.patch<{ Params: { id: string } }>('/api/triggers/:id', async (req, reply) => {
    const body = patchSchema.parse(req.body ?? {});
    if (Object.keys(body).length === 0) {
      void reply.code(400);
      return { error: '无更新字段' };
    }
    const db = getDb();
    if (body.defId) {
      const def = await db.select({ id: schema.workflowDefs.id }).from(schema.workflowDefs).where(eq(schema.workflowDefs.id, body.defId)).limit(1);
      if (!def[0]) {
        void reply.code(400);
        return { error: `工作流不存在: ${body.defId}` };
      }
    }
    await db.update(schema.requirementTriggers).set(body).where(eq(schema.requirementTriggers.id, req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/triggers/:id', async (req) => {
    // 级联删除对应 intake 记录（schema onDelete cascade）
    await getDb().delete(schema.requirementTriggers).where(eq(schema.requirementTriggers.id, req.params.id));
    return { ok: true };
  });

  /** 需求列表：intake join run 状态（触发→运行追溯） */
  app.get('/api/requirements', async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.requirementIntakes.id,
        triggerId: schema.requirementIntakes.triggerId,
        forge: schema.requirementIntakes.forge,
        repo: schema.requirementIntakes.repo,
        issueNumber: schema.requirementIntakes.issueNumber,
        title: schema.requirementIntakes.title,
        author: schema.requirementIntakes.author,
        issueUrl: schema.requirementIntakes.issueUrl,
        runId: schema.requirementIntakes.runId,
        status: schema.requirementIntakes.status,
        runStatus: schema.workflowRuns.status,
        createdAt: schema.requirementIntakes.createdAt,
      })
      .from(schema.requirementIntakes)
      .leftJoin(schema.workflowRuns, eq(schema.requirementIntakes.runId, schema.workflowRuns.id))
      .orderBy(desc(schema.requirementIntakes.createdAt))
      .limit(200);
    return { requirements: rows };
  });

  /** 手动触发一轮需求轮询（调试用） */
  app.post('/api/triggers/poll', async () => {
    const count = await pollIntakesOnce();
    return { polled: count };
  });
}
