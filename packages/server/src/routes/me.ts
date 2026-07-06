/** 当前用户信息与 per-forge token 绑定（设计 §12.3 / 调研 §9.2 的 whoami 前置检查） */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { ForgeError } from '../forge/http';
import { getForge, isForgeKind } from '../forge/registry';
import type { ForgeKind } from '../forge/types';
import { encryptSecret } from '../services/crypto';

const tokenBodySchema = z.object({ token: z.string().min(10) });
const FORGES: ForgeKind[] = ['gitcode', 'github'];

const llmKeyBodySchema = z.object({ key: z.string().min(10) });
const LLM_PROVIDERS = ['deepseek', 'glm'] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
function isLlmProvider(v: string): v is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(v);
}

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req) => {
    const db = getDb();
    const rows = await db
      .select({ forge: schema.forgeTokens.forge, login: schema.forgeTokens.login })
      .from(schema.forgeTokens)
      .where(eq(schema.forgeTokens.userId, req.user!.id));
    // 兼容旧 gitcode 绑定
    const legacy = await db
      .select({ login: schema.userSettings.gitcodeLogin })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, req.user!.id))
      .limit(1);
    const forges: Record<string, { bound: boolean; login?: string }> = {};
    for (const f of FORGES) {
      forges[f] = { bound: false };
    }
    for (const r of rows) {
      forges[r.forge] = { bound: true, login: r.login ?? undefined };
    }
    if (!forges.gitcode!.bound && legacy[0]?.login) {
      forges.gitcode = { bound: true, login: legacy[0].login };
    }
    const llmRows = await db
      .select({ provider: schema.llmKeys.provider })
      .from(schema.llmKeys)
      .where(eq(schema.llmKeys.userId, req.user!.id));
    const llm: Record<string, { bound: boolean }> = {};
    for (const p of LLM_PROVIDERS) {
      llm[p] = { bound: false };
    }
    for (const r of llmRows) {
      llm[r.provider] = { bound: true };
    }
    const larkRow = await db
      .select({ enabled: schema.larkWebhooks.enabled })
      .from(schema.larkWebhooks)
      .where(eq(schema.larkWebhooks.userId, req.user!.id))
      .limit(1);
    const lark = larkRow[0]
      ? { bound: true, enabled: larkRow[0].enabled === 'yes' }
      : { bound: false, enabled: false };
    return { user: req.user, forges, llm, lark };
  });

  /** 绑定/更新某 forge 的 token：先 getUser 验证有效性并取回身份 */
  app.put<{ Params: { forge: string } }>('/api/me/forge-token/:forge', async (req, reply) => {
    if (!isForgeKind(req.params.forge)) {
      void reply.code(400);
      return { error: `未知 forge: ${req.params.forge}` };
    }
    const forge = req.params.forge;
    const body = tokenBodySchema.parse(req.body);
    let login: string;
    try {
      login = (await getForge(forge).getUser(body.token)).login;
    } catch (err) {
      void reply.code(400);
      const detail = err instanceof ForgeError ? `${forge} 返回 ${err.status}` : String(err);
      return { error: `token 验证失败（${detail}）。请确认 token 有效且未过期。` };
    }
    const db = getDb();
    await db
      .insert(schema.forgeTokens)
      .values({ userId: req.user!.id, forge, tokenEnc: encryptSecret(body.token), login, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.forgeTokens.userId, schema.forgeTokens.forge],
        set: { tokenEnc: encryptSecret(body.token), login, updatedAt: new Date() },
      });
    return { ok: true, forge, login };
  });

  app.delete<{ Params: { forge: string } }>('/api/me/forge-token/:forge', async (req, reply) => {
    if (!isForgeKind(req.params.forge)) {
      void reply.code(400);
      return { error: `未知 forge: ${req.params.forge}` };
    }
    const db = getDb();
    await db
      .delete(schema.forgeTokens)
      .where(and(eq(schema.forgeTokens.userId, req.user!.id), eq(schema.forgeTokens.forge, req.params.forge)));
    if (req.params.forge === 'gitcode') {
      await db
        .update(schema.userSettings)
        .set({ gitcodeTokenEnc: null, gitcodeLogin: null, updatedAt: new Date() })
        .where(eq(schema.userSettings.userId, req.user!.id));
    }
    return { ok: true };
  });

  /** 绑定/更新某 LLM provider 的 API key：密文入库，spawn 时优先于 server env */
  app.put<{ Params: { provider: string } }>('/api/me/llm-key/:provider', async (req, reply) => {
    if (!isLlmProvider(req.params.provider)) {
      void reply.code(400);
      return { error: `未知 LLM provider: ${req.params.provider}` };
    }
    const provider = req.params.provider;
    const body = llmKeyBodySchema.parse(req.body);
    const db = getDb();
    await db
      .insert(schema.llmKeys)
      .values({ userId: req.user!.id, provider, keyEnc: encryptSecret(body.key), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.llmKeys.userId, schema.llmKeys.provider],
        set: { keyEnc: encryptSecret(body.key), updatedAt: new Date() },
      });
    return { ok: true, provider };
  });

  app.delete<{ Params: { provider: string } }>('/api/me/llm-key/:provider', async (req, reply) => {
    if (!isLlmProvider(req.params.provider)) {
      void reply.code(400);
      return { error: `未知 LLM provider: ${req.params.provider}` };
    }
    const db = getDb();
    await db
      .delete(schema.llmKeys)
      .where(and(eq(schema.llmKeys.userId, req.user!.id), eq(schema.llmKeys.provider, req.params.provider)));
    return { ok: true };
  });

  // ---------- 飞书/Lark webhook 绑定 ----------

  const larkWebhookUrlSchema = z.object({
    url: z.string().url().refine(
      (url) => {
        try {
          const u = new URL(url);
          return (
            u.protocol === 'https:' &&
            (u.hostname === 'open.feishu.cn' || u.hostname === 'open.larksuite.com') &&
            u.pathname.includes('/open-apis/bot/')
          );
        } catch {
          return false;
        }
      },
      { message: '必须是飞书/Lark 自定义机器人 webhook URL（https://open.feishu.cn/open-apis/bot/... 或 https://open.larksuite.com/open-apis/bot/...）' },
    ),
  });

  const larkEnabledSchema = z.object({ enabled: z.boolean() });

  /** 绑定/更新飞书 webhook：校验 URL 格式 → 加密入库 */
  app.put('/api/me/lark-webhook', async (req, reply) => {
    let body;
    try {
      body = larkWebhookUrlSchema.parse(req.body);
    } catch {
      void reply.code(400);
      return { error: 'URL 格式无效：必须是飞书/Lark 自定义机器人 webhook' };
    }
    const db = getDb();
    await db
      .insert(schema.larkWebhooks)
      .values({ userId: req.user!.id, urlEnc: encryptSecret(body.url), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.larkWebhooks.userId,
        set: { urlEnc: encryptSecret(body.url), enabled: 'yes', updatedAt: new Date() },
      });
    return { ok: true };
  });

  /** 暂停/恢复推送（无需重填 URL） */
  app.patch('/api/me/lark-webhook', async (req, reply) => {
    let body;
    try {
      body = larkEnabledSchema.parse(req.body);
    } catch {
      void reply.code(400);
      return { error: 'enabled 必须为 boolean' };
    }
    const db = getDb();
    await db
      .update(schema.larkWebhooks)
      .set({ enabled: body.enabled ? 'yes' : 'no', updatedAt: new Date() })
      .where(eq(schema.larkWebhooks.userId, req.user!.id));
    return { ok: true };
  });

  /** 解绑飞书 webhook */
  app.delete('/api/me/lark-webhook', async (req) => {
    const db = getDb();
    await db
      .delete(schema.larkWebhooks)
      .where(eq(schema.larkWebhooks.userId, req.user!.id));
    return { ok: true };
  });
}
