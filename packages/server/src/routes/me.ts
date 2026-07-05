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
    return { user: req.user, forges };
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
}
