/**
 * GitCode API 客户端（docs/research/gitcode-api.md 的落地）。
 * 要点：Bearer 主通道 + 正常 UA；418(WAF)/429/5xx 指数退避；
 * 令牌桶 ~300/min 软限；PR 创建 ensure 语义（409 → 解析已有号）；PATCH 后 re-GET。
 * 公开仓库读操作支持匿名（token 可选）。
 */

const BASE = 'https://api.gitcode.com/api/v5';
const UA = 'Mozilla/5.0 (X11; Linux aarch64) code-orchestrator/0.1';
const SOFT_LIMIT_PER_MIN = 300;

export class GitcodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
  }
}

export interface PullInfo {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  head?: { sha?: string; ref?: string };
  mergeable_state?: {
    state?: string;
    conflict_passed?: boolean;
    ci_state_passed?: boolean;
    resolve_discussion_passed?: boolean;
    reason?: Record<string, string>;
  };
  html_url?: string;
}

export interface PullComment {
  id: number;
  body: string;
  comment_type?: string;
  user?: { login?: string; name?: string };
  created_at?: string;
}

/** 简单令牌桶：全局串行队列 + 最小间隔 */
class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly minIntervalMs = Math.ceil(60_000 / SOFT_LIMIT_PER_MIN);

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.last = Date.now();
      return fn();
    });
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

const throttle = new Throttle();

async function request<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastErr: Error = new Error('unreachable');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await throttle.run(async () => {
        const headers: Record<string, string> = { 'user-agent': UA, accept: 'application/json' };
        if (opts.token) {
          headers.authorization = `Bearer ${opts.token}`;
        }
        if (opts.body !== undefined) {
          headers['content-type'] = 'application/json';
        }
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          // 无超时的 fetch 会被黑洞连接永久挂住，进而卡死 poller 的互斥锁（实测踩坑）
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        if (!res.ok) {
          throw new GitcodeError(res.status, `${method} ${path} → ${res.status}`, text.slice(0, 500));
        }
        return (text ? JSON.parse(text) : {}) as T;
      });
    } catch (err) {
      lastErr = err as Error;
      const status = err instanceof GitcodeError ? err.status : 0;
      // 418=WAF、429=限流、5xx、网络错误 → 退避重试；其余直接抛
      const retryable = status === 418 || status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt === retries) {
        throw lastErr;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export const gitcode = {
  /** token 校验 + 身份获取（录入 per-user token 时用） */
  getUser: (token: string) => request<{ login: string; name?: string; id: number }>('GET', '/user', { token }),

  /** 单次 GET 同时拿 labels + mergeable_state（轮询主请求） */
  getPull: (repo: string, number: number, token?: string) =>
    request<PullInfo>('GET', `/repos/${repo}/pulls/${number}`, { token }),

  listPullComments: (repo: string, number: number, token?: string) =>
    request<PullComment[]>('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100`, { token }),

  createPullComment: (repo: string, number: number, body: string, token: string) =>
    request<PullComment>('POST', `/repos/${repo}/pulls/${number}/comments`, { token, body: { body } }),

  /** ensure 语义：409（分支已有 open PR）时解析已有 PR 号返回 */
  createPull: async (
    repo: string,
    params: { title: string; head: string; base: string; body?: string },
    token: string,
  ): Promise<{ number: number; existed: boolean }> => {
    try {
      const pr = await request<PullInfo>('POST', `/repos/${repo}/pulls`, { token, body: params, retries: 1 });
      return { number: pr.number, existed: false };
    } catch (err) {
      if (err instanceof GitcodeError && err.status === 409) {
        const match = err.body?.match(/!(\d+)/);
        if (match) {
          return { number: Number(match[1]), existed: true };
        }
      }
      throw err;
    }
  },

  getIssue: (repo: string, number: string | number, token?: string) =>
    request<{ id: number; number: string; title: string; body?: string; state: string }>(
      'GET',
      `/repos/${repo}/issues/${number}`,
      { token },
    ),

  createIssueComment: (repo: string, number: string | number, body: string, token: string) =>
    request<{ id: number }>('POST', `/repos/${repo}/issues/${number}/comments`, { token, body: { body } }),
};

// token 解析统一走 ./tokens.ts（per-user 优先，GITCODE_TOKEN env 兜底）
