/**
 * 飞书 webhook 发送客户端。
 *
 * 用全局 fetch POST JSON 到群机器人 webhook URL，加 8s 超时。
 * 网络异常/超时不抛出，统一以 LarkSendResult 返回。
 *
 * 自测点：
 *   sendLark('https://open.feishu.cn/open-apis/bot/v2/hook/xxx', { msg_type:'interactive', card:{...} })
 *     → 正常响应 { ok:true }
 *   sendLark('https://open.feishu.cn/open-apis/bot/v2/hook/xxx', ...) 且飞书返回 { code:19001, msg:'invalid' }
 *     → { ok:false, code:19001, msg:'invalid' }
 *   sendLark('https://invalid.url/not-exist', ...)
 *     → { ok:false, msg: ... } 不抛异常
 */

import type { LarkMessage } from './format';

export interface LarkSendResult {
  ok: boolean;
  code?: number;
  msg?: string;
}

const SEND_TIMEOUT_MS = 8_000;

/**
 * 向飞书群机器人 webhook 发送消息。
 *
 * @param webhookUrl 群机器人 webhook 完整 URL
 * @param message    formatLarkEvent 返回的 LarkMessage
 * @returns 发送结果，网络异常/超时不抛异常
 */
export async function sendLark(webhookUrl: string, message: LarkMessage): Promise<LarkSendResult> {
  const body = serializeMessage(message);

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, msg };
  }

  // HTTP 非 2xx 也返回 ok:false
  if (!response.ok) {
    const text = await safeText(response);
    return { ok: false, code: response.status, msg: text };
  }

  // 解析飞书响应体
  try {
    const json = (await response.json()) as Record<string, unknown>;
    const code = toNumber(json.code) ?? toNumber(json.StatusCode);
    if (code !== 0) {
      return { ok: false, code, msg: str(json.msg ?? json.statusMessage) };
    }
    return { ok: true, code: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, msg: `parse response failed: ${msg}` };
  }
}

// ---------- 内部工具 ----------

/** 序列化 message 为 JSON 字符串（兼容 msg_type + card 结构） */
function serializeMessage(msg: LarkMessage): string {
  if (msg.msg_type === 'interactive') {
    return JSON.stringify({ msg_type: 'interactive', card: msg.card });
  }
  return JSON.stringify({ msg_type: 'text', content: msg.content });
}

/** 安全读 response.text()，吞掉异常 */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `(status ${res.status})`;
  }
}

/** 未知值转 number，非数字返回 undefined */
function toNumber(val: unknown): number | undefined {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function str(val: unknown): string {
  return val == null ? '' : String(val);
}
