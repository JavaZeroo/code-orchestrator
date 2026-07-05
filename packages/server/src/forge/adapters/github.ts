/**
 * GitHub adapter。CI 状态来自 check-runs + legacy commit status（比 gitcode 标签精确）；
 * PR 创建 ensure 靠 422 后按 head 查已有 open PR。评论合并 issue 评论 + 行级 review 评论。
 * 直连 api.github.com（实测 server 所在容器可直达，无需代理）。
 */

import { createRequester, ForgeError } from '../http';
import type {
  CiState,
  CreatePullParams,
  Forge,
  ForgeUser,
  NormalizedComment,
  NormalizedIssue,
  NormalizedPull,
} from '../types';

const request = createRequester({
  base: 'https://api.github.com',
  authHeader: (token) => ({ authorization: `Bearer ${token}` }),
  defaultHeaders: {
    'user-agent': 'code-orchestrator/0.1',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  },
  softLimitPerMin: 300,
});

interface RawPull {
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  mergeable?: boolean | null;
  head?: { sha?: string; ref?: string };
  html_url?: string;
}

interface RawComment {
  id: number;
  body: string;
  user?: { login?: string; type?: string };
}

interface RawIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  user?: { login?: string };
  html_url?: string;
  pull_request?: unknown;
}

interface CheckRunsResp {
  check_runs?: Array<{ status?: string; conclusion?: string | null }>;
}
interface CombinedStatusResp {
  state?: string;
  total_count?: number;
}

function ownerOf(repo: string): string {
  return repo.split('/')[0] ?? '';
}

function labelsOf(r: RawIssue): string[] {
  return (r.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
}

function normIssue(r: RawIssue): NormalizedIssue {
  return {
    number: String(r.number),
    title: r.title,
    body: r.body,
    state: r.state,
    labels: labelsOf(r),
    author: r.user?.login,
    htmlUrl: r.html_url,
  };
}

/** 合并 check-runs 与 legacy status 推导归一化 CI 状态 */
async function ciForSha(repo: string, sha: string | undefined, token?: string): Promise<CiState> {
  if (!sha) {
    return 'unknown';
  }
  let failed = false;
  let running = false;
  let anySuccess = false;
  try {
    const checks = await request<CheckRunsResp>('GET', `/repos/${repo}/commits/${sha}/check-runs`, { token });
    for (const c of checks.check_runs ?? []) {
      if (c.status !== 'completed') {
        running = true;
      } else if (c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled') {
        failed = true;
      } else if (c.conclusion === 'success') {
        anySuccess = true;
      }
    }
  } catch {
    /* 无 checks 权限或未配置 */
  }
  try {
    const st = await request<CombinedStatusResp>('GET', `/repos/${repo}/commits/${sha}/status`, { token });
    if (st.state === 'failure' || st.state === 'error') {
      failed = true;
    } else if (st.state === 'pending' && (st.total_count ?? 0) > 0) {
      running = true;
    } else if (st.state === 'success' && (st.total_count ?? 0) > 0) {
      anySuccess = true;
    }
  } catch {
    /* ignore */
  }
  if (failed) {
    return 'failed';
  }
  if (running) {
    return 'running';
  }
  return anySuccess ? 'passed' : 'unknown';
}

export const githubForge: Forge = {
  kind: 'github',

  getUser: (token) => request<ForgeUser>('GET', '/user', { token }),

  async getPull(repo, number, token) {
    const r = await request<RawPull>('GET', `/repos/${repo}/pulls/${number}`, { token });
    const state = r.merged ? 'merged' : r.state;
    const ciState = await ciForSha(repo, r.head?.sha, token);
    return {
      number: r.number,
      title: r.title,
      state,
      ciState,
      conflictPassed: r.mergeable === false ? false : r.mergeable === true ? true : undefined,
      headSha: r.head?.sha,
      htmlUrl: r.html_url,
      detail: { ciState },
    } satisfies NormalizedPull;
  },

  async listPullComments(repo, number, token) {
    const [issueComments, reviewComments] = await Promise.all([
      request<RawComment[]>('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`, { token }),
      request<RawComment[]>('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100`, { token }).catch(() => []),
    ]);
    const map = (c: RawComment, kind: 'issue' | 'diff'): NormalizedComment => ({
      id: c.id,
      body: c.body,
      author: c.user?.login ?? 'unknown',
      kind: kind === 'diff' ? 'diff' : 'review',
      isBot: c.user?.type === 'Bot',
    });
    // 合并后按 id 排序；github 评论 id 全局单调，水位取 max 有效
    return [...issueComments.map((c) => map(c, 'issue')), ...reviewComments.map((c) => map(c, 'diff'))].sort(
      (a, b) => a.id - b.id,
    );
  },

  async createPullComment(repo, number, body, token) {
    const c = await request<{ id: number }>('POST', `/repos/${repo}/issues/${number}/comments`, { token, body: { body } });
    return { id: c.id };
  },

  async createPull(repo, params: CreatePullParams, token) {
    try {
      const pr = await request<RawPull>('POST', `/repos/${repo}/pulls`, { token, body: params, retries: 1 });
      return { number: pr.number, existed: false };
    } catch (err) {
      if (err instanceof ForgeError && err.status === 422) {
        const head = params.head.includes(':') ? params.head : `${ownerOf(repo)}:${params.head}`;
        const existing = await request<RawPull[]>(
          'GET',
          `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
          { token },
        );
        if (existing[0]) {
          return { number: existing[0].number, existed: true };
        }
      }
      throw err;
    }
  },

  async getIssue(repo, number, token) {
    const r = await request<RawIssue>('GET', `/repos/${repo}/issues/${number}`, { token });
    return normIssue(r);
  },

  async createIssueComment(repo, number, body, token) {
    const c = await request<{ id: number }>('POST', `/repos/${repo}/issues/${number}/comments`, { token, body: { body } });
    return { id: c.id };
  },

  async listIssues(repo, opts, token) {
    const q = new URLSearchParams({ state: opts.state ?? 'open', per_page: '100' });
    if (opts.labels?.length) {
      q.set('labels', opts.labels.join(','));
    }
    if (opts.since) {
      q.set('since', opts.since);
    }
    const raw = await request<RawIssue[]>('GET', `/repos/${repo}/issues?${q.toString()}`, { token });
    // github 的 issues 列表含 PR，用 pull_request 字段过滤掉
    return raw.filter((r) => !r.pull_request).map(normIssue);
  },
};
