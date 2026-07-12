import { lstat, realpath, unlink } from 'node:fs/promises';
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
    if (!targetStat.isFile()) throw new Error('path is not a regular file');
    await unlink(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const deleteContainerFile: ContainerDelete = async (containerId, root, path) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
target="$root/$2"
parent=$(readlink -f -- "\${target%/*}")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ "$target" != "$root" ] || { echo 'workspace root cannot be deleted' >&2; exit 43; }
[ ! -L "$target" ] || { echo 'workspace symlinks cannot be deleted' >&2; exit 44; }
[ -f "$target" ] || { echo 'path is not a regular file' >&2; exit 45; }
rm -f -- "$target"`;
  await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, path]);
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
