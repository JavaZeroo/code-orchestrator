/**
 * 子进程环境构造：runner 自身进程env 全量拷贝给 agent 子进程时，必须剔除控制面密钥。
 * agent 可在会话里执行任意 bash（`env` 即可读全量环境）——RUNNER_SHARED_TOKEN 一旦落入，
 * 模型可冒充本 runner 连 server（注册机器、伪造心跳/会话事件）。
 *
 * 只剔 runner 控制面密钥；模型凭据（ANTHROPIC_* 等）是 agent 的运行时必需品，由调用方显式注入。
 */

/** runner 控制面密钥：永不传给 agent 子进程 */
const DENYLIST = new Set(['RUNNER_SHARED_TOKEN']);

/** 复制 process.env（剔除 denylist 与非字符串值），供 agent 子进程作为基础环境 */
export function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !DENYLIST.has(key)) {
      env[key] = value;
    }
  }
  return env;
}
