/**
 * forge adapter 共享的限流 HTTP 客户端工厂。
 * 每个 adapter 用自己的 base/UA/默认头/软限构造一个 request 函数：
 * - 令牌桶（全局串行 + 最小间隔）防超限
 * - 20s 超时（无超时 fetch 会被黑洞连接挂死进而卡住 poller）
 * - 对 418(WAF)/429/5xx/网络错误指数退避重试
 */

export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
  }
}

class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;

  constructor(softLimitPerMin: number) {
    this.minIntervalMs = Math.ceil(60_000 / softLimitPerMin);
  }

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

export interface RequesterOptions {
  base: string;
  /** token → 认证头（各 forge 略有差异，但都可用 Bearer） */
  authHeader: (token: string) => Record<string, string>;
  defaultHeaders?: Record<string, string>;
  softLimitPerMin?: number;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  retries?: number;
  /** 覆盖 base（如 github 分页 Link 的绝对 URL） */
  absoluteUrl?: string;
}

export function createRequester(opts: RequesterOptions) {
  const throttle = new Throttle(opts.softLimitPerMin ?? 300);
  return async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const retries = o.retries ?? 3;
    let lastErr: Error = new Error('unreachable');
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await throttle.run(async () => {
          const headers: Record<string, string> = { accept: 'application/json', ...(opts.defaultHeaders ?? {}) };
          if (o.token) {
            Object.assign(headers, opts.authHeader(o.token));
          }
          if (o.body !== undefined) {
            headers['content-type'] = 'application/json';
          }
          const res = await fetch(o.absoluteUrl ?? `${opts.base}${path}`, {
            method,
            headers,
            body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
            signal: AbortSignal.timeout(20_000),
          });
          const text = await res.text();
          if (!res.ok) {
            throw new ForgeError(res.status, `${method} ${path} → ${res.status}`, text.slice(0, 500));
          }
          return (text ? JSON.parse(text) : {}) as T;
        });
      } catch (err) {
        lastErr = err as Error;
        const status = err instanceof ForgeError ? err.status : 0;
        const retryable = status === 418 || status === 429 || status >= 500 || status === 0;
        if (!retryable || attempt === retries) {
          throw lastErr;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr;
  };
}
