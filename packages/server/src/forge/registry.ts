/** Forge adapter 注册表 + 便捷选择器 */

import { gitcodeForge } from './adapters/gitcode';
import { githubForge } from './adapters/github';
import type { Forge, ForgeKind } from './types';

const forges: Record<ForgeKind, Forge> = {
  gitcode: gitcodeForge,
  github: githubForge,
};

export function getForge(kind: ForgeKind): Forge {
  return forges[kind] ?? gitcodeForge;
}

export function isForgeKind(v: string): v is ForgeKind {
  return v === 'gitcode' || v === 'github';
}

/** 从 URL 识别 forge 与 owner/repo/number（agent 输出中的 PR/issue 链接自动登记用） */
export function parseForgeUrl(
  url: string,
): { forge: ForgeKind; repo: string; number: number; kind: 'pr' | 'issue' } | null {
  const gh = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/);
  if (gh) {
    return { forge: 'github', repo: gh[1]!, number: Number(gh[3]), kind: gh[2] === 'issues' ? 'issue' : 'pr' };
  }
  const gc = url.match(/gitcode\.com\/([\w.-]+\/[\w.-]+)\/(?:merge_requests|pulls)\/(\d+)/);
  if (gc) {
    return { forge: 'gitcode', repo: gc[1]!, number: Number(gc[2]), kind: 'pr' };
  }
  const gcIssue = url.match(/gitcode\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (gcIssue) {
    return { forge: 'gitcode', repo: gcIssue[1]!, number: Number(gcIssue[2]), kind: 'issue' };
  }
  return null;
}
