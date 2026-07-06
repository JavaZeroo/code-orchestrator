/**
 * 工作区物化（server 侧，design-v2 M1）：调用【目标 runner】的 workspace.provision RPC，
 * 在那台机的数据盘上 clone+worktree，并记账到 project_materializations（黏性调度 / 冷热判定）。
 * 取代 server-local 的 provisionWorkspace（后者保留为无 runner-dataRoot 的退化路径）。
 */

import { and, eq } from 'drizzle-orm';
import { getDb, hasDb, schema } from '../db/index';
import { callRunner } from '../ws/runnerHub';
import type { ForgeKind } from '../forge/types';

const HOSTS: Record<ForgeKind, string> = {
  github: 'github.com',
  gitcode: 'gitcode.com',
};

/** 计算 clone URL；有 token 则内嵌（Q10 注入可接受）。token 以「用户名」位注入，广被 https git 接受。 */
function cloneUrl(forge: ForgeKind, repo: string, token?: string): string {
  const host = HOSTS[forge];
  return token ? `https://${encodeURIComponent(token)}@${host}/${repo}.git` : `https://${host}/${repo}.git`;
}

export interface MaterializeOpts {
  machineId: string;
  forge: ForgeKind;
  repo: string;
  /** 唯一稳定键（issue number / runId / sessionId） */
  key: string;
  base?: string;
  /** 归属项目：非空则记账 project_materializations */
  projectId?: string;
  /** 已解密的 forge token（Q10 注入）；空则用主机 git 凭据 */
  token?: string;
  installDeps?: boolean;
}

export interface Materialized {
  cwd: string;
  branch: string;
  basePath?: string;
}

/** 在目标 runner 上物化 worktree。runner 未上报 dataRoot 时仍可（退到 home）。失败抛错。 */
export async function materializeWorkspace(opts: MaterializeOpts): Promise<Materialized> {
  const base = opts.base ?? 'main';
  if (hasDb() && opts.projectId) {
    await getDb()
      .insert(schema.projectMaterializations)
      .values({ projectId: opts.projectId, machineId: opts.machineId, basePath: '', status: 'materializing' })
      .onConflictDoUpdate({
        target: [schema.projectMaterializations.projectId, schema.projectMaterializations.machineId],
        set: { status: 'materializing' },
      });
  }

  const res = await callRunner(opts.machineId, 'workspace.provision', {
    forge: opts.forge,
    repo: opts.repo,
    key: opts.key,
    base,
    cloneUrl: cloneUrl(opts.forge, opts.repo, opts.token),
    gitProxy: process.env.WORKSPACE_GIT_PROXY,
    installDeps: opts.installDeps ?? false,
    gitName: process.env.WORKSPACE_GIT_NAME,
    gitEmail: process.env.WORKSPACE_GIT_EMAIL,
  });

  if (!res.ok || !res.cwd || !res.branch) {
    if (hasDb() && opts.projectId) {
      await getDb()
        .update(schema.projectMaterializations)
        .set({ status: 'failed' })
        .where(
          and(
            eq(schema.projectMaterializations.projectId, opts.projectId),
            eq(schema.projectMaterializations.machineId, opts.machineId),
          ),
        );
    }
    throw new Error(`workspace.provision failed @ ${opts.machineId}: ${res.error ?? 'unknown'}`);
  }

  if (hasDb() && opts.projectId) {
    await getDb()
      .update(schema.projectMaterializations)
      .set({ status: 'ready', basePath: res.basePath ?? '', lastUsedAt: new Date() })
      .where(
        and(
          eq(schema.projectMaterializations.projectId, opts.projectId),
          eq(schema.projectMaterializations.machineId, opts.machineId),
        ),
      );
  }

  return { cwd: res.cwd, branch: res.branch, basePath: res.basePath };
}
