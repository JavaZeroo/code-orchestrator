/**
 * Forge 抽象接口（设计文档 §使用建议）：代码托管后端可插拔。
 * poller / routes / 引擎 只依赖这里的接口与归一化类型，gitcode / github 为具体 adapter。
 */

export type ForgeKind = 'gitcode' | 'github';

export interface ForgeUser {
  login: string;
  name?: string;
}

/** 归一化的 CI/门禁状态（各 forge 从不同来源推导：gitcode 看标签，github 看 checks） */
export type CiState = 'passed' | 'failed' | 'running' | 'pending' | 'unknown';

export interface NormalizedPull {
  number: number;
  title: string;
  /** open / closed / merged */
  state: string;
  ciState: CiState;
  /** false = 与目标分支有冲突；undefined = 未知/计算中 */
  conflictPassed?: boolean;
  headSha?: string;
  htmlUrl?: string;
  /** 供 nudge 上下文与 UI 展示的原始细节（标签 / 未过原因 / 失败 check 名） */
  detail?: Record<string, unknown>;
}

export interface NormalizedComment {
  /** 单调递增数字 id，用作轮询水位 */
  id: number;
  body: string;
  author: string;
  /** review=普通评论 diff=行级评审 issue=issue 评论 */
  kind: 'review' | 'diff' | 'issue';
  isBot: boolean;
}

export interface NormalizedIssue {
  number: string;
  title: string;
  body?: string;
  state: string;
  labels: string[];
  author?: string;
  htmlUrl?: string;
}

export interface CreatePullParams {
  title: string;
  /** 同仓分支名；跨 fork 用 owner:branch */
  head: string;
  base: string;
  body?: string;
}

export interface Forge {
  readonly kind: ForgeKind;
  /** token 校验 + 身份（绑定 per-user token 时用） */
  getUser(token: string): Promise<ForgeUser>;
  getPull(repo: string, number: number, token?: string): Promise<NormalizedPull>;
  listPullComments(repo: string, number: number, token?: string): Promise<NormalizedComment[]>;
  createPullComment(repo: string, number: number, body: string, token: string): Promise<{ id: number }>;
  /** ensure 语义：分支已有 open PR 时返回其编号（existed=true），不报错 */
  createPull(repo: string, params: CreatePullParams, token: string): Promise<{ number: number; existed: boolean }>;
  getIssue(repo: string, number: string | number, token?: string): Promise<NormalizedIssue>;
  createIssueComment(repo: string, number: string | number, body: string, token: string): Promise<{ id: number }>;
  /** 列出仓库 issue（需求录入触发器用）；opts.since 为 ISO8601 增量 */
  listIssues(repo: string, opts: { state?: string; labels?: string[]; since?: string }, token?: string): Promise<NormalizedIssue[]>;
}
