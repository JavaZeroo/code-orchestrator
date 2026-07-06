/**
 * 自动工作区供给（让 需求→PR 全链路无人值守）。
 * 每个 run 分一个隔离的 git worktree：基于 repo 的一份共享 base 克隆，切出独立分支。
 * 触发器起 run 前调用，注入 vars.cwd / vars.branch，agent 直接在里面干活、提 PR，互不干扰。
 *
 * 约束（当前实现）：单机——base 克隆与 worktree 落在 server 所在主机本地盘（WORKSPACE_ROOT）。
 * 多机部署需改为「在目标 runner 上供给」的 RPC（后续）。认证走主机环境里已配置的 git 凭据
 * （github 用 gh credential helper）；私有仓的 token 化 clone 暂未做。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ForgeKind } from './types';

const run = promisify(execFile);

const HOSTS: Record<ForgeKind, string> = {
  github: 'https://github.com',
  gitcode: 'https://gitcode.com',
};

/** repo 的 base 克隆一次成型，按 repo 串行化，避免并发首建互踩 */
const baseLocks = new Map<string, Promise<string>>();

function slug(forge: ForgeKind, repo: string): string {
  return `${forge}__${repo.replace(/\//g, '__')}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function ensureBase(root: string, forge: ForgeKind, repo: string): Promise<string> {
  const key = slug(forge, repo);
  const existing = baseLocks.get(key);
  if (existing) {
    return existing;
  }
  const p = (async () => {
    const base = join(root, 'base', key);
    if (existsSync(join(base, '.git'))) {
      await git(base, ['fetch', 'origin', '--prune', '--quiet']).catch(() => {});
      return base;
    }
    await mkdir(join(root, 'base'), { recursive: true });
    const url = `${HOSTS[forge]}/${repo}.git`;
    const proxy = process.env.WORKSPACE_GIT_PROXY;
    // 代理须在 clone 命令内联传入（server 进程 env 未必带 http_proxy）
    const cloneArgs = proxy ? ['-c', `http.proxy=${proxy}`, 'clone', '--quiet', url, base] : ['clone', '--quiet', url, base];
    await run('git', cloneArgs, { maxBuffer: 8 * 1024 * 1024 });
    // 持久化到 base 的 common config，供后续 fetch / worktree 复用
    if (proxy) {
      await git(base, ['config', 'http.proxy', proxy]).catch(() => {});
    }
    await git(base, ['config', 'user.name', process.env.WORKSPACE_GIT_NAME ?? 'code-orchestrator']).catch(() => {});
    await git(base, ['config', 'user.email', process.env.WORKSPACE_GIT_EMAIL ?? 'co@localhost']).catch(() => {});
    return base;
  })();
  baseLocks.set(key, p);
  try {
    return await p;
  } catch (err) {
    baseLocks.delete(key); // 失败允许重试
    throw err;
  }
}

export interface Workspace {
  cwd: string;
  branch: string;
}

/**
 * 为一个 run 供给隔离 worktree。WORKSPACE_ROOT 未配置时返回 null（功能关闭，沿用触发器静态 cwd）。
 * key 需唯一稳定（用 issue number / runId）；base 为目标基线分支。
 */
export async function provisionWorkspace(
  forge: ForgeKind,
  repo: string,
  key: string,
  base = 'main',
): Promise<Workspace | null> {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) {
    return null;
  }
  const baseDir = await ensureBase(root, forge, repo);
  const branch = `co/${key}`;
  const wt = join(root, 'wt', `${slug(forge, repo)}__${key}`);
  await mkdir(join(root, 'wt'), { recursive: true });
  // 已存在则先摘除，保证每次是基于最新 base 的干净工作区
  await git(baseDir, ['worktree', 'remove', '--force', wt]).catch(() => {});
  await git(baseDir, ['worktree', 'add', '--force', '-B', branch, wt, `origin/${base}`]);
  return { cwd: wt, branch };
}
