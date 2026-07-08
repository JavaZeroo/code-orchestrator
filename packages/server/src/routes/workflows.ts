import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { asc, desc, eq, inArray, or } from 'drizzle-orm';
import * as z from 'zod';
import { workflowDefSchema } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { EngineError, startRun } from '../engine/engine';

const createBodySchema = z.object({
  graph: z.unknown(),
  createdVia: z.enum(['chat', 'manual']).default('manual'),
  projectId: z.string().nullable().optional(),
});

const startBodySchema = z.object({
  vars: z.record(z.string(), z.string()).default({}),
  projectId: z.string().nullable().optional(),
});

const patchDefSchema = z.object({
  archived: z.enum(['yes', 'no']).optional(),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/workflows', async (req, reply) => {
    const body = createBodySchema.parse(req.body);
    const graph = workflowDefSchema.parse(body.graph);
    const id = createId();
    await getDb().insert(schema.workflowDefs).values({
      id,
      name: graph.name,
      graph,
      createdVia: body.createdVia,
      projectId: body.projectId ?? null,
    });
    void reply.code(201);
    return { id, name: graph.name };
  });

  app.get('/api/workflows', async () => {
    const defs = await getDb()
      .select()
      .from(schema.workflowDefs)
      .orderBy(desc(schema.workflowDefs.createdAt))
      .limit(100);
    return {
      workflows: defs.map((def) => ({
        ...def,
        nodeCount: ((def.graph as Record<string, unknown>).nodes as unknown[])?.length ?? 0,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const rows = await getDb().select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, req.params.id)).limit(1);
    if (!rows[0]) {
      void reply.code(404);
      return { error: 'workflow not found' };
    }
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const patch = patchDefSchema.parse(req.body ?? {});
    if (Object.keys(patch).length === 0) {
      void reply.code(400);
      return { error: '无更新字段' };
    }
    await getDb().update(schema.workflowDefs).set(patch).where(eq(schema.workflowDefs.id, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/runs', async (req, reply) => {
    const body = startBodySchema.parse(req.body ?? {});
    try {
      const runId = await startRun(req.params.id, body.vars, body.projectId ?? undefined);
      void reply.code(201);
      return { runId };
    } catch (err) {
      if (err instanceof EngineError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/api/runs', async () => {
    const runs = await getDb()
      .select({
        id: schema.workflowRuns.id,
        defId: schema.workflowRuns.defId,
        defName: schema.workflowDefs.name,
        projectId: schema.workflowRuns.projectId,
        status: schema.workflowRuns.status,
        context: schema.workflowRuns.context,
        startedAt: schema.workflowRuns.startedAt,
        endedAt: schema.workflowRuns.endedAt,
      })
      .from(schema.workflowRuns)
      .leftJoin(schema.workflowDefs, eq(schema.workflowRuns.defId, schema.workflowDefs.id))
      .orderBy(desc(schema.workflowRuns.startedAt))
      .limit(100);
    return { runs };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const db = getDb();
    const runs = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, req.params.id)).limit(1);
    const run = runs[0];
    if (!run) {
      void reply.code(404);
      return { error: 'run not found' };
    }
    const defs = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
    const nodes = await db
      .select({
        runId: schema.nodeStates.runId,
        nodeId: schema.nodeStates.nodeId,
        status: schema.nodeStates.status,
        sessionId: schema.nodeStates.sessionId,
        output: schema.nodeStates.output,
        updatedAt: schema.nodeStates.updatedAt,
        model: schema.sessions.model,
      })
      .from(schema.nodeStates)
      .leftJoin(schema.sessions, eq(schema.nodeStates.sessionId, schema.sessions.id))
      .where(eq(schema.nodeStates.runId, run.id));
    return { run, def: defs[0], nodes };
  });

  /** 合流时间线：run 级事件 + 所有关联会话消息 + forge refs，按 seq 升序 */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/runs/:id/thread',
    async (req, reply) => {
      const db = getDb();
      const since = Number(req.query.since ?? 0);

      // ① run + def + nodes（复用 /:id 逻辑）
      const runs = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, req.params.id)).limit(1);
      const run = runs[0];
      if (!run) {
        void reply.code(404);
        return { error: 'run not found' };
      }
      const defs = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, run.defId)).limit(1);
      const nodes = await db
        .select({
          runId: schema.nodeStates.runId,
          nodeId: schema.nodeStates.nodeId,
          status: schema.nodeStates.status,
          sessionId: schema.nodeStates.sessionId,
          output: schema.nodeStates.output,
          updatedAt: schema.nodeStates.updatedAt,
          model: schema.sessions.model,
        })
        .from(schema.nodeStates)
        .leftJoin(schema.sessions, eq(schema.nodeStates.sessionId, schema.sessions.id))
        .where(eq(schema.nodeStates.runId, run.id));

      // ② 本 run 的全部会话 id（用于兜底历史 session.message 行无 runId）
      const sessionRows = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.runId, run.id));
      const sessionIds = sessionRows.map((r) => r.id);

      // ③ 合流事件：runId 匹配 OR sessionId 属于本 run
      const conditions = [eq(schema.events.runId, run.id)];
      if (sessionIds.length > 0) {
        conditions.push(inArray(schema.events.sessionId, sessionIds));
      }
      const rows = await db
        .select()
        .from(schema.events)
        .where(or(...conditions))
        .orderBy(asc(schema.events.seq))
        .limit(2000);
      const events = since > 0 ? rows.filter((r) => r.seq > since) : rows;

      // ④ forge refs
      const forgeRefs = await db
        .select()
        .from(schema.forgeRefs)
        .where(eq(schema.forgeRefs.runId, run.id));

      return { run, def: defs[0], nodes, events, forgeRefs };
    },
  );
}
