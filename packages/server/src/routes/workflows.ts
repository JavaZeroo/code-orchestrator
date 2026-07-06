import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { workflowDefSchema } from '@co/protocol';
import { getDb, schema } from '../db/index';
import { EngineError, startRun } from '../engine/engine';

const createBodySchema = z.object({
  graph: z.unknown(),
  createdVia: z.enum(['chat', 'manual']).default('manual'),
});

const startBodySchema = z.object({
  vars: z.record(z.string(), z.string()).default({}),
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

  app.post<{ Params: { id: string } }>('/api/workflows/:id/runs', async (req, reply) => {
    const body = startBodySchema.parse(req.body ?? {});
    try {
      const runId = await startRun(req.params.id, body.vars);
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
}
