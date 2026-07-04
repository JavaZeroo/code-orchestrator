/** forge token 解析：请求者本人 → 任一已绑定用户（轮询分摊）→ GITCODE_TOKEN env → 匿名 */

import { eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { env } from '../env';
import { decryptSecret } from '../services/crypto';

export async function userForgeToken(userId: string): Promise<string | undefined> {
  if (!env.AUTH_SECRET) {
    return undefined;
  }
  const rows = await getDb()
    .select({ enc: schema.userSettings.gitcodeTokenEnc })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .limit(1);
  const enc = rows[0]?.enc;
  return enc ? decryptSecret(enc) : undefined;
}

let cached: { token?: string; at: number } | null = null;

export async function anyForgeToken(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.token;
  }
  let token: string | undefined;
  if (env.AUTH_SECRET) {
    const rows = await getDb()
      .select({ enc: schema.userSettings.gitcodeTokenEnc })
      .from(schema.userSettings)
      .where(isNotNull(schema.userSettings.gitcodeTokenEnc))
      .limit(1);
    token = rows[0]?.enc ? decryptSecret(rows[0].enc) : undefined;
  }
  token = token ?? process.env.GITCODE_TOKEN ?? undefined;
  cached = { token, at: Date.now() };
  return token;
}
