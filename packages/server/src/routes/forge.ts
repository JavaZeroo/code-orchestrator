import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { pollOnce } from '../forge/poller';
import { getForge } from '../forge/registry';
import { ForgeCommentError, forgeCommentService } from '../forge/comment';
import { ForgeRetestError, forgeRetestService } from '../forge/retest';
import { anyForgeToken, userForgeToken } from '../forge/tokens';

const createRefSchema = z.object({
  forge: z.enum(['gitcode', 'github']).default('gitcode'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式: owner/repo'),
  number: z.number().int().positive(),
  kind: z.enum(['pr', 'issue']).default('pr'),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  nodeId: z.string().optional(),
});

const createCommentSchema = z.object({ body: z.string().trim().min(1).max(10_000) });

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

  /** 使用请求者本人绑定的 token 给活跃 GitCode PR 发布 /retest，后续状态仍由 poller 确认 */
  app.post<{ Params: { id: string } }>('/api/forge/refs/:id/retest', async (req, reply) => {
    try {
      return await forgeRetestService.request(req.params.id, req.user?.id);
    } catch (err) {
      if (err instanceof ForgeRetestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/forge/refs/:id/comments', async (req, reply) => {
    const body = createCommentSchema.parse(req.body);
    try {
      return await forgeCommentService.request(req.params.id, body.body, req.user?.id);
    } catch (err) {
      if (err instanceof ForgeCommentError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  /** 客户端连通性冒烟：透传一次归一化 PR 查询（优先请求者自己的 token） */
  app.get<{ Querystring: { forge?: string; repo: string; number: string } }>('/api/forge/preview', async (req) => {
    const forgeKind = req.query.forge === 'github' ? 'github' : 'gitcode';
    const token = (req.user ? await userForgeToken(req.user.id, forgeKind) : undefined) ?? (await anyForgeToken(forgeKind));
    const pr = await getForge(forgeKind).getPull(req.query.repo, Number(req.query.number), token);
    return { forge: forgeKind, number: pr.number, title: pr.title, state: pr.state, ciState: pr.ciState, conflictPassed: pr.conflictPassed };
  });

  /** 手动触发一轮轮询（调试用） */
  app.post('/api/forge/poll', async () => {
    const count = await pollOnce();
    return { polled: count };
  });
}
