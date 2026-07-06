/**
 * 飞书事件派发器：订阅事件总线，命中目标事件后读取所有启用的 per-user webhook，
 * 格式化成飞书交互式卡片并推送。
 *
 * 广播语义：群机器人是团队级，命中事件推送给所有已启用 webhook（本阶段不做 event→user 定向）。
 * 任何失败只 console.error 不冒泡，不因飞书故障影响主流程/事件总线。
 */

import { eq } from 'drizzle-orm';
import { bus } from '../events';
import { hasDb, getDb, schema } from '../db/index';
import { env } from '../env';
import { decryptSecret } from '../services/crypto';
import { formatLarkEvent, type NotifiableEvent } from './format';
import { sendLark } from './client';

/** 关注的事件类型集合；其余类型直接跳过，避免每次查库 */
const TARGET_EVENT_TYPES = new Set([
  'approval.requested',
  'nudge.sent',
  'run.finished',
  'requirement.triggered',
]);

/**
 * 启动飞书事件派发器：订阅事件总线。
 * DB 未就绪时不订阅。
 */
export function startLarkNotifier(): void {
  if (!hasDb()) {
    return;
  }

  bus.on('event', (evt: NotifiableEvent) => {
    // 快速早退：非目标事件类型直接跳过
    if (!TARGET_EVENT_TYPES.has(evt.type)) {
      return;
    }

    void (async () => {
      try {
        const db = getDb();
        const rows = await db
          .select()
          .from(schema.larkWebhooks)
          .where(eq(schema.larkWebhooks.enabled, 'yes'));

        if (rows.length === 0) {
          return;
        }

        const msg = formatLarkEvent(evt, { baseUrl: env.PUBLIC_URL });
        if (!msg) {
          return;
        }

        for (const row of rows) {
          void (async () => {
            try {
              const url = decryptSecret(row.urlEnc);
              const result = await sendLark(url, msg);
              if (!result.ok) {
                console.error(
                  `[lark] send failed for user ${row.userId}: code=${result.code ?? '-'} msg=${result.msg ?? '-'}`,
                );
              }
            } catch (err) {
              console.error(
                `[lark] send error for user ${row.userId}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          })();
        }
      } catch (err) {
        console.error(
          '[lark] notifier handler error:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  });
}
