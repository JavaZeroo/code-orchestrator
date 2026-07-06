/**
 * 飞书相关 API 路由：测试发送等。
 * 需认证（在 authEnabled 分支注册）。
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { decryptSecret } from '../services/crypto';
import { formatLarkEvent } from '../lark/format';
import { sendLark } from '../lark/client';

export async function registerLarkRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 测试发送：向当前用户的飞书 webhook 发送一条示例消息。
   * 忽略 enabled 标志（手动验证用）。
   */
  app.post('/api/lark/test', async (req, reply) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.larkWebhooks)
      .where(eq(schema.larkWebhooks.userId, req.user!.id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      void reply.code(400);
      return { error: '尚未配置飞书 webhook' };
    }

    let url: string;
    try {
      url = decryptSecret(row.urlEnc);
    } catch (err) {
      void reply.code(500);
      return { error: 'webhook 解密失败', detail: err instanceof Error ? err.message : String(err) };
    }

    // 构造一条示例 run.finished 事件用于格式化测试
    const testEvent = {
      type: 'run.finished' as const,
      runId: 'run_test_' + String(Date.now()),
      payload: { status: 'done' },
    };
    const msg = formatLarkEvent(testEvent, { baseUrl: '' });
    if (!msg) {
      void reply.code(500);
      return { error: '构造示例消息失败' };
    }

    const result = await sendLark(url, msg);
    return { ok: result.ok, code: result.code, msg: result.msg };
  });
}
