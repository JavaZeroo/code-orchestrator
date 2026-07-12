import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const run = promisify(execFile);
type ContainerCopy = (containerId: string, source: string, target: string) => Promise<void>;

const dockerCopy: ContainerCopy = async (containerId, source, target) => {
  await run('docker', ['cp', `${containerId}:${source}`, target], { maxBuffer: 1024 * 1024 });
};

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

export async function readHostWorkspaceFile(root: string, path: string): Promise<RunnerResult<'workspace.read'>> {
  try {
    validateRelativePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    const resolved = await realpath(requested);
    if (!confined(realRoot, resolved)) throw new Error('symlink escapes the workspace');

    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('path is not a regular file');
      if (stat.size > WORKSPACE_FILE_MAX_BYTES) {
        throw new Error(`file exceeds the ${WORKSPACE_FILE_MAX_BYTES}-byte limit`);
      }
      const data = await handle.readFile();
      return { ok: true, basename: basename(path), size: data.length, data: data.toString('base64') };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readWorkspaceFile(
  p: RunnerParams<'workspace.read'>,
  copyContainerFile: ContainerCopy = dockerCopy,
): Promise<RunnerResult<'workspace.read'>> {
  if (!p.containerId) return readHostWorkspaceFile(p.root, p.path);
  try {
    validateRelativePath(p.path);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const temp = await mkdtemp(`${tmpdir()}/co-artifact-`);
  const target = resolve(temp, basename(p.path));
  try {
    await copyContainerFile(p.containerId, resolve(p.root, p.path), target);
    return await readHostWorkspaceFile(temp, basename(target));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
