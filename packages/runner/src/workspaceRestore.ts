import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
const RESTORE_TIMEOUT_MS = 20_000;

export type WorkspaceRestoreExecutor = (
  root: string,
  path: string,
  containerId?: string,
) => Promise<void>;

function validateRelativePath(path: string): void {
  if (path.includes('\0') || isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

async function git(
  root: string,
  containerId: string | undefined,
  args: string[],
): Promise<{ stdout: Buffer }> {
  const command = containerId ? 'docker' : 'git';
  const commandArgs = containerId
    ? ['exec', containerId, 'git', '--literal-pathspecs', '-C', root, ...args]
    : ['--literal-pathspecs', '-C', root, ...args];
  const result = await run(command, commandArgs, {
    encoding: 'buffer',
    timeout: RESTORE_TIMEOUT_MS,
  });
  return { stdout: Buffer.from(result.stdout) };
}

export const executeGitRestore: WorkspaceRestoreExecutor = async (root, path, containerId) => {
  const { stdout } = await git(root, containerId, ['ls-tree', '-z', 'HEAD', '--', path]);
  const records = stdout.toString('utf8').split('\0').filter(Boolean);
  const expectedSuffix = `\t${path}`;
  if (records.length !== 1 || !records[0]?.endsWith(expectedSuffix) || !/^\d+ blob /.test(records[0])) {
    throw new Error('path is not a tracked file in Git HEAD');
  }
  await git(root, containerId, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
};

function restoreError(err: unknown): string {
  const detail = err as { stderr?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(detail.stderr) ? detail.stderr.toString('utf8') : detail.stderr;
  if (/not a git repository/i.test(stderr ?? '')) return 'not a git repository';
  return stderr?.trim().slice(0, 500) || detail.message || String(err);
}

export async function restoreWorkspaceFile(
  params: RunnerParams<'workspace.restore'>,
  execute: WorkspaceRestoreExecutor = executeGitRestore,
): Promise<RunnerResult<'workspace.restore'>> {
  try {
    validateRelativePath(params.path);
    await execute(params.root, params.path, params.containerId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: restoreError(err) };
  }
}
