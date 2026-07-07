/** Project 一等配置容器的 CRUD（grill-me 共识 Q7）。trigger 归属 project、继承其策略。 */

import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';

const bodySchema = z.object({
  name: z.string().min(1),
  forge: z.enum(['gitcode', 'github']),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式: owner/repo'),
  autonomy: z.enum(['manual', 'agent', 'auto']).default('manual'),
  guardrails: z.array(z.string()).default([]),
  defaultDefId: z.string().nullable().optional(),
  models: z.record(z.string(), z.string()).default({}),
  vars: z.record(z.string(), z.string()).default({}),
  // design-v2：容器化执行配置
  baseImage: z.string().nullable().optional(),
  accel: z.object({ kind: z.string() }).nullable().optional(),
  components: z.record(z.string(), z.string()).optional(),
  memoryRepo: z.string().nullable().optional(),
});

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/projects', async (req, reply) => {
    const body = bodySchema.parse(req.body);
    const id = createId();
    await getDb().insert(schema.projects).values({ id, ...body, defaultDefId: body.defaultDefId ?? null, createdBy: req.user?.id });
    void reply.code(201);
    return { id };
  });

  app.get('/api/projects', async () => {
    const rows = await getDb().select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).limit(200);
    return { projects: rows };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const patch = bodySchema.partial().parse(req.body ?? {});
    if (Object.keys(patch).length === 0) {
      void reply.code(400);
      return { error: '无更新字段' };
    }
    await getDb().update(schema.projects).set(patch).where(eq(schema.projects.id, req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    // 先解绑其 trigger 的 projectId，再删项目（避免 FK 阻塞）
    await getDb().update(schema.requirementTriggers).set({ projectId: null }).where(eq(schema.requirementTriggers.projectId, req.params.id));
    await getDb().delete(schema.projects).where(eq(schema.projects.id, req.params.id));
    return { ok: true };
  });
}
