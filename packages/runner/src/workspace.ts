/**
 * 工作区物化（design-v2 M1）：在【本机】数据盘上 clone base + 切 per-key worktree。
 * 取代 server-local 供给——这是「多机」得以成立的结构性前提（worktree 必须落在真正跑会话的机器本地盘）。
 * 布局：<dataRoot>/co/base/<slug>（clone 一次）、<dataRoot>/co/wt/<slug>__<key>（per 会话）。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams } from '@co/protocol';
import { config } from './config';

const run = promisify(execFile);

/** base 克隆按 slug 串行化，避免并发首建互踩 */
const baseLocks = new Map<string, Promise<string>>();

function slug(forge: string, repo: string): string {
  return `${forge}__${repo.replace(/\//g, '__')}`;
}

/** co 物化根：优先本机数据盘（design-v2 Q6），未配 DATA_ROOT 时退到 home */
function coRoot(): string {
  return join(config.dataRoot ?? os.homedir(), 'co');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function ensureBase(root: string, p: RunnerParams<'workspace.provision'>): Promise<string> {
  const key = slug(p.forge, p.repo);
  const existing = baseLocks.get(key);
  if (existing) {
    return existing;
  }
  const task = (async () => {
    const base = join(root, 'base', key);
    if (existsSync(join(base, '.git'))) {
      await git(base, ['fetch', 'origin', '--prune', '--quiet']).catch(() => {});
      return base;
    }
    await mkdir(join(root, 'base'), { recursive: true });
    const cloneArgs = p.gitProxy
      ? ['-c', `http.proxy=${p.gitProxy}`, 'clone', '--quiet', p.cloneUrl, base]
      : ['clone', '--quiet', p.cloneUrl, base];
    await run('git', cloneArgs, { maxBuffer: 8 * 1024 * 1024 });
    if (p.gitProxy) {
      await git(base, ['config', 'http.proxy', p.gitProxy]).catch(() => {});
    }
    await git(base, ['config', 'user.name', p.gitName ?? 'code-orchestrator']).catch(() => {});
    await git(base, ['config', 'user.email', p.gitEmail ?? 'co@localhost']).catch(() => {});
    return base;
  })();
  baseLocks.set(key, task);
  try {
    return await task;
  } catch (err) {
    baseLocks.delete(key); // 失败允许重试
    throw err;
  }
}

export interface ProvisionResult {
  ok: boolean;
  cwd?: string;
  branch?: string;
  basePath?: string;
  error?: string;
}

/** 在本机物化一个隔离 worktree，返回其路径（= 容器内 /workspace 的宿主机源）。 */
export async function provisionWorkspace(p: RunnerParams<'workspace.provision'>): Promise<ProvisionResult> {
  try {
    const root = coRoot();
    const baseDir = await ensureBase(root, p);
    // 显式把基线分支拉到本地 tracking（全量 fetch 可能被吞、或基线是非 main 集成分支）
    await git(baseDir, ['fetch', 'origin', `+refs/heads/${p.base}:refs/remotes/origin/${p.base}`, '--quiet']);
    const branch = `co/${p.key}`;
    const wt = join(root, 'wt', `${slug(p.forge, p.repo)}__${p.key}`);
    await mkdir(join(root, 'wt'), { recursive: true });
    await git(baseDir, ['worktree', 'remove', '--force', wt]).catch(() => {});
    await git(baseDir, ['worktree', 'add', '--force', '-B', branch, wt, `origin/${p.base}`]);
    if (p.installDeps) {
      try {
        const binDir = dirname(process.execPath);
        await run('pnpm', ['install', '--prefer-offline', '--config.confirmModulesPurge=false'], {
          cwd: wt,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        });
      } catch (err) {
        console.error(`[workspace] pnpm install failed in ${wt}:`, err instanceof Error ? err.message : err);
      }
    }
    return { ok: true, cwd: wt, branch, basePath: baseDir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
