import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, hasDb, schema } from '../db/index';
import { projectCapabilityMetrics } from '../services/capabilityMetrics';

const querySchema = z.object({ runId: z.string().trim().min(1).optional() });
const CAPABILITY_EVENT_TYPES = [
  'run.capability.attempt',
  'run.capability.evaluation',
  'run.capability.evidence',
  'run.capability.context_pack',
  'run.capability.outcome',
] as const;
const MAX_METRIC_EVENTS = 10_000;

export async function registerCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/capability/metrics', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
    const query = querySchema.parse(req.query ?? {});
    const capabilityEvents = inArray(schema.events.type, [...CAPABILITY_EVENT_TYPES]);
    const rows = await getDb()
      .select({ type: schema.events.type, payload: schema.events.payload })
      .from(schema.events)
      .where(query.runId ? and(capabilityEvents, eq(schema.events.runId, query.runId)) : capabilityEvents)
      .orderBy(desc(schema.events.seq))
      .limit(MAX_METRIC_EVENTS);
    return {
      metrics: projectCapabilityMetrics(rows),
      eventCount: rows.length,
      truncated: rows.length === MAX_METRIC_EVENTS,
    };
  });
}
