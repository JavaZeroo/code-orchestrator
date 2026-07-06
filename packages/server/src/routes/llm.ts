/**
 * LLM 端点注册表路由：用户可管理自定义命名端点（OpenAI/Anthropic 兼容）。
 * 所有权按 created_by 隔离（同 forge_tokens / llm_keys 风格）。
 * GET    /api/llm/endpoints        → 列出所有端点（不返回明文 key）
 * PUT    /api/llm/endpoints/:label → 增改端点（key 加密存储；非 owner 拒绝）
 * DELETE /api/llm/endpoints/:label → 删除端点（非 owner 拒绝）
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { encryptSecret } from '../services/crypto';

const BUILTIN_ALIASES = ['claude', 'deepseek', 'glm'];

const endpointBodySchema = z.object({
  model: z.string().min(1),
  base_url: z.string().min(1),
  api_key: z.string().min(1),
});

export async function registerLlmRoutes(app: FastifyInstance): Promise<void> {
  /** 列出所有端点（不返回明文 key，只返回配置状态） */
  app.get('/api/llm/endpoints', async (req) => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.llmEndpoints.id,
        label: schema.llmEndpoints.label,
        model: schema.llmEndpoints.model,
        baseUrl: schema.llmEndpoints.baseUrl,
        createdBy: schema.llmEndpoints.createdBy,
        createdAt: schema.llmEndpoints.createdAt,
      })
      .from(schema.llmEndpoints)
      .orderBy(schema.llmEndpoints.createdAt);
    return { endpoints: rows.map((r) => ({ ...r, hasKey: true })) };
  });

  /** 增改端点：label 作为唯一键，key 加密存储。非 owner 覆盖现有端点时拒绝。 */
  app.put<{ Params: { label: string } }>('/api/llm/endpoints/:label', async (req, reply) => {
    const label = req.params.label;
    if (label.length < 1 || label.length > 64) {
      void reply.code(400);
      return { error: 'label 长度应为 1-64 字符' };
    }
    if (BUILTIN_ALIASES.includes(label)) {
      void reply.code(400);
      return { error: `"${label}" 是内置别名，不可注册为自定义端点` };
    }
    const body = endpointBodySchema.parse(req.body);
    const db = getDb();

    // 检查现有端点：如果存在且非当前用户创建，拒绝覆盖
    const existing = await db
      .select({ createdBy: schema.llmEndpoints.createdBy })
      .from(schema.llmEndpoints)
      .where(eq(schema.llmEndpoints.label, label))
      .limit(1);
    if (existing[0] && existing[0].createdBy !== req.user?.id) {
      void reply.code(403);
      return { error: `端点 "${label}" 由其他用户创建，不可修改` };
    }

    const id = createId();
    await db
      .insert(schema.llmEndpoints)
      .values({
        id,
        label,
        model: body.model,
        baseUrl: body.base_url,
        apiKeyEnc: encryptSecret(body.api_key),
        createdBy: req.user?.id,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.llmEndpoints.label,
        set: {
          model: body.model,
          baseUrl: body.base_url,
          apiKeyEnc: encryptSecret(body.api_key),
          createdBy: req.user?.id,
          createdAt: new Date(),
        },
      });
    return { ok: true, label };
  });

  /** 删除端点：仅允许创建者删除，其余用户 403 */
  app.delete<{ Params: { label: string } }>('/api/llm/endpoints/:label', async (req, reply) => {
    const db = getDb();

    const existing = await db
      .select({ createdBy: schema.llmEndpoints.createdBy })
      .from(schema.llmEndpoints)
      .where(eq(schema.llmEndpoints.label, req.params.label))
      .limit(1);
    if (!existing[0]) {
      void reply.code(404);
      return { error: `端点 "${req.params.label}" 不存在` };
    }
    if (existing[0].createdBy !== req.user?.id) {
      void reply.code(403);
      return { error: `端点 "${req.params.label}" 由其他用户创建，不可删除` };
    }

    await db.delete(schema.llmEndpoints).where(eq(schema.llmEndpoints.label, req.params.label));
    return { ok: true };
  });
}
