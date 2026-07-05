/**
 * GitCode adapter（docs/research/gitcode-api.md 的落地）。
 * CI 状态源自 PR 标签（gitcode 无 commit status API，见调研 §5）；PR 创建 ensure 靠 409 解析 !NNNN。
 */

import { createRequester, ForgeError } from '../http';
import type {
  CreatePullParams,
  Forge,
  ForgeUser,
  NormalizedComment,
  NormalizedIssue,
  NormalizedPull,
  CiState,
} from '../types';

const request = createRequester({
  base: 'https://api.gitcode.com/api/v5',
  authHeader: (token) => ({ authorization: `Bearer ${token}` }),
  defaultHeaders: { 'user-agent': 'Mozilla/5.0 (X11; Linux aarch64) code-orchestrator/0.1' },
  softLimitPerMin: 300,
});

interface RawPull {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string }>;
  head?: { sha?: string; ref?: string };
  mergeable_state?: { conflict_passed?: boolean; reason?: Record<string, string> };
  html_url?: string;
}

interface RawComment {
  id: number;
  body: string;
  comment_type?: string;
  user?: { login?: string; name?: string };
}

interface RawIssue {
  number: string;
  title: string;
  body?: string;
  state: string;
  labels?: Array<{ name: string }>;
  user?: { login?: string };
  html_url?: string;
}

function ciFromLabels(labels: string[]): CiState {
  if (labels.includes('ci-pipeline-passed')) {
    return 'passed';
  }
  if (labels.includes('ci-pipeline-failed') || labels.includes('pr-ci-fail')) {
    return 'failed';
  }
  if (labels.includes('ci-pipeline-running') || labels.includes('SC-RUNNING')) {
    return 'running';
  }
  return 'unknown';
}

function isBot(login: string): boolean {
  return /bot|ci|compass/i.test(login);
}

function normIssue(r: RawIssue): NormalizedIssue {
  return {
    number: String(r.number),
    title: r.title,
    body: r.body,
    state: r.state,
    labels: (r.labels ?? []).map((l) => l.name),
    author: r.user?.login,
    htmlUrl: r.html_url,
  };
}

export const gitcodeForge: Forge = {
  kind: 'gitcode',

  getUser: (token) => request<ForgeUser>('GET', '/user', { token }),

  async getPull(repo, number, token) {
    const r = await request<RawPull>('GET', `/repos/${repo}/pulls/${number}`, { token });
    const labels = (r.labels ?? []).map((l) => l.name);
    return {
      number: r.number,
      title: r.title,
      state: r.state,
      ciState: ciFromLabels(labels),
      conflictPassed: r.mergeable_state?.conflict_passed,
      headSha: r.head?.sha,
      htmlUrl: r.html_url,
      detail: { labels, reason: r.mergeable_state?.reason },
    } satisfies NormalizedPull;
  },

  async listPullComments(repo, number, token) {
    const raw = await request<RawComment[]>('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100`, { token });
    return raw.map((c): NormalizedComment => {
      const author = c.user?.login ?? c.user?.name ?? 'unknown';
      return {
        id: c.id,
        body: c.body,
        author,
        kind: c.comment_type === 'diff_comment' ? 'diff' : 'review',
        isBot: isBot(author),
      };
    });
  },

  async createPullComment(repo, number, body, token) {
    const c = await request<{ id: number }>('POST', `/repos/${repo}/pulls/${number}/comments`, { token, body: { body } });
    return { id: c.id };
  },

  async createPull(repo, params: CreatePullParams, token) {
    try {
      const pr = await request<RawPull>('POST', `/repos/${repo}/pulls`, { token, body: params, retries: 1 });
      return { number: pr.number, existed: false };
    } catch (err) {
      if (err instanceof ForgeError && err.status === 409) {
        const m = err.body?.match(/!(\d+)/);
        if (m) {
          return { number: Number(m[1]), existed: true };
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
    return raw.map(normIssue);
  },
};
