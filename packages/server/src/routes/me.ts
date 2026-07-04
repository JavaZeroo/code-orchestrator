/** 当前用户信息与 gitcode token 绑定（per-user token，设计 §12.3 / 调研 §9.2） */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { gitcode, GitcodeError } from '../forge/gitcode';
import { encryptSecret } from '../services/crypto';

const tokenBodySchema = z.object({ token: z.string().min(10) });

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req) => {
    const db = getDb();
    const rows = await db
      .select({ gitcodeLogin: schema.userSettings.gitcodeLogin })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, req.user!.id))
      .limit(1);
    return {
      user: req.user,
      gitcode: rows[0]?.gitcodeLogin ? { bound: true, login: rows[0].gitcodeLogin } : { bound: false },
    };
  });

  /** 绑定/更新 gitcode token：先 GET /user 验证有效性并取回身份（调研 §9.2 的 whoami 前置检查） */
  app.put('/api/me/gitcode-token', async (req, reply) => {
    const body = tokenBodySchema.parse(req.body);
    let login: string;
    try {
      const who = await gitcode.getUser(body.token);
      login = who.login;
    } catch (err) {
      void reply.code(400);
      const detail = err instanceof GitcodeError ? `gitcode 返回 ${err.status}` : String(err);
      return { error: `token 验证失败（${detail}）。请确认 token 有效且未过期。` };
    }
    const db = getDb();
    await db
      .insert(schema.userSettings)
      .values({
        userId: req.user!.id,
        gitcodeTokenEnc: encryptSecret(body.token),
        gitcodeLogin: login,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.userSettings.userId,
        set: { gitcodeTokenEnc: encryptSecret(body.token), gitcodeLogin: login, updatedAt: new Date() },
      });
    return { ok: true, login };
  });

  app.delete('/api/me/gitcode-token', async (req) => {
    await getDb()
      .update(schema.userSettings)
      .set({ gitcodeTokenEnc: null, gitcodeLogin: null, updatedAt: new Date() })
      .where(eq(schema.userSettings.userId, req.user!.id));
    return { ok: true };
  });
}
