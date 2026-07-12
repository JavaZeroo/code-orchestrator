import { lstat, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
type ContainerDelete = (containerId: string, root: string, path: string) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

export async function deleteHostWorkspaceFile(root: string, path: string): Promise<RunnerResult<'workspace.delete'>> {
  try {
    validateRelativePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    if (requested === realRoot) throw new Error('workspace root cannot be deleted');
    const parent = await realpath(dirname(requested));
    if (!confined(realRoot, parent)) throw new Error('symlink escapes the workspace');
    const target = resolve(parent, basename(requested));
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) throw new Error('workspace symlinks cannot be deleted');
    if (targetStat.isFile()) await unlink(target);
    else if (targetStat.isDirectory()) await rmdir(target);
    else throw new Error('path is not a regular file or directory');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const containerWorkspaceDeleteScript = String.raw`set -eu
root=$(readlink -f -- "$1")
target="$root/$2"
parent=$(readlink -f -- "$(dirname -- "$target")")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ "$target" != "$root" ] || { echo 'workspace root cannot be deleted' >&2; exit 43; }
[ ! -L "$target" ] || { echo 'workspace symlinks cannot be deleted' >&2; exit 44; }
if [ -f "$target" ]; then
  rm -f -- "$target"
elif [ -d "$target" ]; then
  rmdir -- "$target"
else
  echo 'path is not a regular file or directory' >&2
  exit 45
fi`;

const deleteContainerFile: ContainerDelete = async (containerId, root, path) => {
  await run('docker', ['exec', containerId, 'sh', '-c', containerWorkspaceDeleteScript, 'sh', root, path]);
};

export async function deleteWorkspaceFile(
  p: RunnerParams<'workspace.delete'>,
  deleteContainer: ContainerDelete = deleteContainerFile,
): Promise<RunnerResult<'workspace.delete'>> {
  try {
    validateRelativePath(p.path);
    if (!p.containerId) return deleteHostWorkspaceFile(p.root, p.path);
    await deleteContainer(p.containerId, p.root, p.path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
