import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_PATCH_MAX_BYTES = 10 * 1024 * 1024;
const PATCH_TIMEOUT_MS = 20_000;
const run = promisify(execFile);

export type WorkspacePatchExecutor = (root: string, containerId?: string) => Promise<Buffer>;

const executeGitPatch: WorkspacePatchExecutor = async (root, containerId) => {
  const command = containerId ? 'docker' : 'git';
  const args = containerId
    ? ['exec', containerId, 'git', '-C', root, 'diff', '--binary', 'HEAD']
    : ['diff', '--binary', 'HEAD'];
  const { stdout } = await run(command, args, {
    cwd: containerId ? undefined : root,
    encoding: 'buffer',
    maxBuffer: WORKSPACE_PATCH_MAX_BYTES,
    timeout: PATCH_TIMEOUT_MS,
  });
  return Buffer.from(stdout);
};

function patchError(err: unknown): string {
  const detail = err as { code?: string; stderr?: Buffer | string; message?: string };
  if (detail.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `patch exceeds the ${WORKSPACE_PATCH_MAX_BYTES}-byte limit`;
  }
  const stderr = Buffer.isBuffer(detail.stderr) ? detail.stderr.toString('utf8') : detail.stderr;
  if (/not a git repository/i.test(stderr ?? '')) return 'not a git repository';
  return stderr?.trim().slice(0, 500) || detail.message || String(err);
}

export async function generateWorkspacePatch(
  params: RunnerParams<'workspace.patch'>,
  execute: WorkspacePatchExecutor = executeGitPatch,
): Promise<RunnerResult<'workspace.patch'>> {
  try {
    const patch = await execute(params.root, params.containerId);
    if (patch.length > WORKSPACE_PATCH_MAX_BYTES) {
      throw new Error(`patch exceeds the ${WORKSPACE_PATCH_MAX_BYTES}-byte limit`);
    }
    return { ok: true, size: patch.length, data: patch.toString('base64') };
  } catch (err) {
    return { ok: false, error: patchError(err) };
  }
}
