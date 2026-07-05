/**
 * per-forge token 解析：请求者本人 → 任一已绑定用户（轮询分摊）→ 环境变量兜底 → 匿名。
 * 从 forge_tokens 表读；gitcode 兼容旧 user_settings 字段；env 兜底 GITCODE_TOKEN / GITHUB_TOKEN。
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { env } from '../env';
import { decryptSecret } from '../services/crypto';
import type { ForgeKind } from './types';

function envTokenFor(forge: ForgeKind): string | undefined {
  if (forge === 'github') {
    return process.env.GITHUB_TOKEN || undefined;
  }
  return process.env.GITCODE_TOKEN || undefined;
}

/** 请求者本人绑定的 token */
export async function userForgeToken(userId: string, forge: ForgeKind): Promise<string | undefined> {
  if (!env.AUTH_SECRET) {
    return undefined;
  }
  const db = getDb();
  const rows = await db
    .select({ enc: schema.forgeTokens.tokenEnc })
    .from(schema.forgeTokens)
    .where(and(eq(schema.forgeTokens.userId, userId), eq(schema.forgeTokens.forge, forge)))
    .limit(1);
  if (rows[0]?.enc) {
    return decryptSecret(rows[0].enc);
  }
  // gitcode 兼容旧 user_settings 绑定
  if (forge === 'gitcode') {
    const legacy = await db
      .select({ enc: schema.userSettings.gitcodeTokenEnc })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1);
    if (legacy[0]?.enc) {
      return decryptSecret(legacy[0].enc);
    }
  }
  return undefined;
}

const cache = new Map<ForgeKind, { token?: string; at: number }>();

/** 任一已绑定用户的 token（轮询用，分摊配额）；60s 缓存 */
export async function anyForgeToken(forge: ForgeKind): Promise<string | undefined> {
  const hit = cache.get(forge);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.token;
  }
  let token: string | undefined;
  if (env.AUTH_SECRET) {
    const db = getDb();
    const rows = await db
      .select({ enc: schema.forgeTokens.tokenEnc })
      .from(schema.forgeTokens)
      .where(eq(schema.forgeTokens.forge, forge))
      .limit(1);
    token = rows[0]?.enc ? decryptSecret(rows[0].enc) : undefined;
    if (!token && forge === 'gitcode') {
      const legacy = await db
        .select({ enc: schema.userSettings.gitcodeTokenEnc })
        .from(schema.userSettings)
        .where(isNotNull(schema.userSettings.gitcodeTokenEnc))
        .limit(1);
      token = legacy[0]?.enc ? decryptSecret(legacy[0].enc) : undefined;
    }
  }
  token = token ?? envTokenFor(forge);
  cache.set(forge, { token, at: Date.now() });
  return token;
}
