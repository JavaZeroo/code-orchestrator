import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import { hasDb } from '../db/index';
import { searchConversationContent } from '../services/conversationSearch';

const conversationSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).optional(),
});

export async function registerConversationSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; projectId?: string } }>('/api/conversations/search', async (req, reply) => {
    if (!hasDb()) {
      void reply.code(503);
      return { error: 'DATABASE_URL 未配置' };
    }
    const { q, projectId } = conversationSearchQuerySchema.parse(req.query);
    return { results: await searchConversationContent(q, projectId) };
  });
}
