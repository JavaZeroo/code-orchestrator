import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { gitcode } from '../forge/gitcode';
import { pollOnce } from '../forge/poller';
import { anyForgeToken, userForgeToken } from '../forge/tokens';

const createRefSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式: owner/repo'),
  number: z.number().int().positive(),
  kind: z.enum(['pr', 'issue']).default('pr'),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  nodeId: z.string().optional(),
});

export async function registerForgeRoutes(app: FastifyInstance): Promise<void> {
  /** 手工登记要跟踪的 PR（agent 输出中的 PR URL 会被引擎自动登记） */
  app.post('/api/forge/refs', async (req, reply) => {
    const body = createRefSchema.parse(req.body);
    const id = createId();
    await getDb().insert(schema.forgeRefs).values({ id, ...body });
    void reply.code(201);
    return { id };
  });

  app.get('/api/forge/refs', async () => {
    const refs = await getDb().select().from(schema.forgeRefs).orderBy(desc(schema.forgeRefs.updatedAt)).limit(100);
    return { refs };
  });

  app.delete<{ Params: { id: string } }>('/api/forge/refs/:id', async (req) => {
    await getDb().update(schema.forgeRefs).set({ active: 'no' }).where(eq(schema.forgeRefs.id, req.params.id));
    return { ok: true };
  });

  /** 客户端连通性冒烟：直接透传一次 PR 查询（优先请求者自己的 token） */
  app.get<{ Querystring: { repo: string; number: string } }>('/api/forge/preview', async (req) => {
    const token = (req.user ? await userForgeToken(req.user.id) : undefined) ?? (await anyForgeToken());
    const pr = await gitcode.getPull(req.query.repo, Number(req.query.number), token);
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      labels: pr.labels.map((l) => l.name),
      ci: pr.mergeable_state
        ? {
            ci_state_passed: pr.mergeable_state.ci_state_passed,
            conflict_passed: pr.mergeable_state.conflict_passed,
            resolve_discussion_passed: pr.mergeable_state.resolve_discussion_passed,
          }
        : null,
    };
  });

  /** 手动触发一轮轮询（调试用） */
  app.post('/api/forge/poll', async () => {
    const count = await pollOnce();
    return { polled: count };
  });
}
