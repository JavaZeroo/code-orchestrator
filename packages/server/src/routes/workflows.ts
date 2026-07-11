import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import * as z from 'zod';
import { workflowDefSchema } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { publish } from '../events';
import { callRunner } from '../ws/runnerHub';
import { EngineError, startRun } from '../engine/engine';
import { archiveWorkflowRun, restoreWorkflowRun, WorkflowRunArchiveError } from '../services/workflowRunArchive';
import { pauseWorkflowRun, resumeWorkflowRun, WorkflowRunProgressionError } from '../services/workflowRunProgression';
import { retryWorkflowRun, WorkflowRunRetryError } from '../services/workflowRunRetry';
import { reviseWorkflowDefinition, WorkflowRevisionError } from '../services/workflowRevision';

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
  name: z.string().trim().min(1).max(120).optional(),
});

const patchRunSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

const reviseBodySchema = z.object({
  graph: z.unknown(),
  createdVia: z.enum(['chat', 'manual']).default('manual'),
});

const listRunsQuerySchema = z.object({ archived: z.enum(['true', 'false']).default('false') });

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
    const db = getDb();
    const rows = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, req.params.id)).limit(1);
    if (!rows[0]) {
      void reply.code(404);
      return { error: 'workflow not found' };
    }
    // 改名同步进 graph.name，保持 def 行与图定义一致
    const set: Record<string, unknown> = { ...patch };
    if (patch.name) {
      set.graph = { ...(rows[0].graph as Record<string, unknown>), name: patch.name };
    }
    await db.update(schema.workflowDefs).set(set).where(eq(schema.workflowDefs.id, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/revisions', async (req, reply) => {
    const body = reviseBodySchema.parse(req.body);
    try {
      const revision = await reviseWorkflowDefinition(req.params.id, body.graph, {
        createdVia: body.createdVia,
        createdBy: req.user?.id,
      });
      void reply.code(201);
      return revision;
    } catch (err) {
      if (err instanceof WorkflowRevisionError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
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

  app.patch<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const body = patchRunSchema.parse(req.body);
    const [run] = await getDb()
      .update(schema.workflowRuns)
      .set({ title: body.title })
      .where(eq(schema.workflowRuns.id, req.params.id))
      .returning({ id: schema.workflowRuns.id, title: schema.workflowRuns.title });
    if (!run) {
      void reply.code(404);
      return { error: 'run not found' };
    }
    return { ok: true, run };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (req, reply) => {
    try {
      const result = await retryWorkflowRun(req.params.id, req.user?.email ?? 'ui');
      return {
        ok: true,
        run: { id: result.run.id, status: result.run.status, endedAt: result.run.endedAt },
        retriedNodeIds: result.retriedNodeIds,
      };
    } catch (err) {
      if (err instanceof WorkflowRunRetryError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/pause', async (req, reply) => {
    try {
      const result = await pauseWorkflowRun(req.params.id, req.user?.email ?? 'ui');
      return { ok: true, run: { id: result.run.id, status: result.run.status } };
    } catch (err) {
      if (err instanceof WorkflowRunProgressionError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (req, reply) => {
    try {
      const result = await resumeWorkflowRun(req.params.id, req.user?.email ?? 'ui');
      return { ok: true, run: { id: result.run.id, status: result.run.status } };
    } catch (err) {
      if (err instanceof WorkflowRunProgressionError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  /** 取消 run：终止活跃节点会话（尽力）、pending 审批过期、状态置 cancelled——此前 run 只能跑完/失败 */
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    const db = getDb();
    const [run] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, req.params.id)).limit(1);
    if (!run) {
      void reply.code(404);
      return { error: 'run not found' };
    }
    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
      void reply.code(409);
      return { error: `run 已终态: ${run.status}` };
    }
    const alive = await db
      .select({ id: schema.sessions.id, machineId: schema.sessions.machineId })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.runId, run.id), ne(schema.sessions.state, 'dead')));
    for (const s of alive) {
      await callRunner(s.machineId, 'session.kill', { sessionId: s.id }).catch(() => {});
      await db.update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, s.id));
    }
    await db
      .update(schema.approvals)
      .set({ status: 'expired', decidedBy: req.user?.email ?? 'cancel', decidedAt: new Date() })
      .where(and(eq(schema.approvals.runId, run.id), eq(schema.approvals.status, 'pending')));
    await db.update(schema.workflowRuns).set({ status: 'cancelled', endedAt: new Date() }).where(eq(schema.workflowRuns.id, run.id));
    await publish({ type: 'run.status', runId: run.id, payload: { status: 'cancelled', by: req.user?.email ?? 'ui' } });
    return { ok: true, killedSessions: alive.length };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/archive', async (req, reply) => {
    try {
      const run = await archiveWorkflowRun(req.params.id);
      return { ok: true, run: { id: run.id, archivedAt: run.archivedAt } };
    } catch (err) {
      if (err instanceof WorkflowRunArchiveError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/restore', async (req, reply) => {
    try {
      const run = await restoreWorkflowRun(req.params.id);
      return { ok: true, run: { id: run.id, archivedAt: run.archivedAt } };
    } catch (err) {
      if (err instanceof WorkflowRunArchiveError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get<{ Querystring: { archived?: string } }>('/api/runs', async (req) => {
    const { archived } = listRunsQuerySchema.parse(req.query);
    const runs = await getDb()
      .select({
        id: schema.workflowRuns.id,
        defId: schema.workflowRuns.defId,
        defName: schema.workflowDefs.name,
        projectId: schema.workflowRuns.projectId,
        title: schema.workflowRuns.title,
        status: schema.workflowRuns.status,
        context: schema.workflowRuns.context,
        startedAt: schema.workflowRuns.startedAt,
        endedAt: schema.workflowRuns.endedAt,
        archivedAt: schema.workflowRuns.archivedAt,
      })
      .from(schema.workflowRuns)
      .leftJoin(schema.workflowDefs, eq(schema.workflowRuns.defId, schema.workflowDefs.id))
      .where(archived === 'true' ? isNotNull(schema.workflowRuns.archivedAt) : isNull(schema.workflowRuns.archivedAt))
      .orderBy(desc(archived === 'true' ? schema.workflowRuns.archivedAt : schema.workflowRuns.startedAt))
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
      //    首次加载返回最新 2000 条（desc+limit+reverse）；since>0 时增量拉取 >since 的事件
      const baseConditions = [eq(schema.events.runId, run.id)];
      if (sessionIds.length > 0) {
        baseConditions.push(inArray(schema.events.sessionId, sessionIds));
      }
      let events;
      if (since > 0) {
        events = await db
          .select()
          .from(schema.events)
          .where(and(or(...baseConditions), gt(schema.events.seq, since)))
          .orderBy(asc(schema.events.seq))
          .limit(2000);
      } else {
        const latest = await db
          .select()
          .from(schema.events)
          .where(or(...baseConditions))
          .orderBy(desc(schema.events.seq))
          .limit(2000);
        events = latest.reverse();
      }

      // ④ forge refs
      const forgeRefs = await db
        .select()
        .from(schema.forgeRefs)
        .where(eq(schema.forgeRefs.runId, run.id));

      return { run, def: defs[0], nodes, events, forgeRefs };
    },
  );
}
