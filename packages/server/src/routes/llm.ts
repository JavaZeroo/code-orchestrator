/**
 * LLM 端点注册表路由：用户可管理自定义命名端点（OpenAI/Anthropic 兼容）。
 * 所有权按 created_by 隔离（同 forge_tokens / llm_keys 风格）。
 * GET    /api/llm/endpoints        → 列出所有端点（不返回明文 key）
 * PUT    /api/llm/endpoints/:label → 增改端点（key 加密存储；非 owner 拒绝）
 * DELETE /api/llm/endpoints/:label → 删除端点（非 owner 拒绝）
 *
 * #61 M1：新增 providers CRUD（provider→model 两级体系）
 * GET    /api/llm/providers        → 列出所有 provider（不返回明文 key）
 * PUT    /api/llm/providers/:name  → 增改 provider（内置可改不可删）
 * DELETE /api/llm/providers/:name  → 删除自定义 provider（内置 405）
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { encryptSecret } from '../services/crypto';

const BUILTIN_ALIASES = ['claude', 'deepseek', 'glm'];
const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'glm'];

const endpointBodySchema = z.object({
  model: z.string().min(1),
  base_url: z.string().min(1),
  api_key: z.string().min(1),
});

const providerBodySchema = z.object({
  base_url: z.string().nullish(),
  api_key: z.string().min(1).optional(),
  models: z.array(z.string()).default([]),
  default_model: z.string().nullish(),
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

  // ---------- #61 providers CRUD ----------

  /** 列出所有 provider（不返回明文 key，只返回 hasKey 状态 + builtin 标记） */
  app.get('/api/llm/providers', async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.llmProviders.id,
        name: schema.llmProviders.name,
        baseUrl: schema.llmProviders.baseUrl,
        models: schema.llmProviders.models,
        defaultModel: schema.llmProviders.defaultModel,
        createdBy: schema.llmProviders.createdBy,
        createdAt: schema.llmProviders.createdAt,
        updatedAt: schema.llmProviders.updatedAt,
        apiKeyEnc: schema.llmProviders.apiKeyEnc,
      })
      .from(schema.llmProviders)
      .orderBy(schema.llmProviders.createdAt);
    return {
      providers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        baseUrl: r.baseUrl,
        models: r.models,
        defaultModel: r.defaultModel,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        hasKey: Boolean(r.apiKeyEnc),
        builtin: BUILTIN_PROVIDERS.includes(r.name),
      })),
    };
  });

  /** 增改 provider：name 作为唯一键。内置 provider 可改不可删。 */
  app.put<{ Params: { name: string } }>('/api/llm/providers/:name', async (req, reply) => {
    const name = req.params.name;
    if (name.length < 1 || name.length > 64) {
      void reply.code(400);
      return { error: 'name 长度应为 1-64 字符' };
    }
    const body = providerBodySchema.parse(req.body);
    const db = getDb();

    // 查现有行
    const existing = await db
      .select({ createdBy: schema.llmProviders.createdBy })
      .from(schema.llmProviders)
      .where(eq(schema.llmProviders.name, name))
      .limit(1);

    // 内置 provider 跳过 owner 校验（任何登录用户可改配置）
    if (!BUILTIN_PROVIDERS.includes(name) && existing[0] && existing[0].createdBy !== req.user?.id) {
      void reply.code(403);
      return { error: `provider "${name}" 由其他用户创建，不可修改` };
    }

    const now = new Date();
    const updateData: Record<string, unknown> = {
      baseUrl: body.base_url ?? null,
      models: body.models,
      defaultModel: body.default_model ?? null,
      updatedAt: now,
    };

    // api_key 提供才加密写入，省略则不进 set（避免改模型时误清 key）
    if (body.api_key !== undefined) {
      updateData.apiKeyEnc = encryptSecret(body.api_key);
    }

    await db
      .insert(schema.llmProviders)
      .values({
        id: createId(),
        name,
        baseUrl: body.base_url ?? null,
        apiKeyEnc: body.api_key !== undefined ? encryptSecret(body.api_key) : null,
        models: body.models,
        defaultModel: body.default_model ?? null,
        createdBy: req.user?.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.llmProviders.name,
        set: updateData,
      });

    return { ok: true, name };
  });

  /** 删除自定义 provider：内置 405，不存在 404，非 owner 403。 */
  app.delete<{ Params: { name: string } }>('/api/llm/providers/:name', async (req, reply) => {
    const db = getDb();
    const name = req.params.name;

    if (BUILTIN_PROVIDERS.includes(name)) {
      void reply.code(405);
      return { error: '内置 provider 不可删除' };
    }

    const existing = await db
      .select({ createdBy: schema.llmProviders.createdBy })
      .from(schema.llmProviders)
      .where(eq(schema.llmProviders.name, name))
      .limit(1);

    if (!existing[0]) {
      void reply.code(404);
      return { error: `provider "${name}" 不存在` };
    }

    if (existing[0].createdBy !== req.user?.id) {
      void reply.code(403);
      return { error: `provider "${name}" 由其他用户创建，不可删除` };
    }

    await db.delete(schema.llmProviders).where(eq(schema.llmProviders.name, name));
    return { ok: true };
  });
}
