import { execFile } from 'node:child_process';
import { lstat, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
type ContainerRename = (containerId: string, root: string, path: string, newName: string) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRename(path: string, newName: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
  if (path.split(/[\\/]+/).every((part) => !part || part === '.')) {
    throw new Error('workspace root cannot be renamed');
  }
  if (!newName || newName === '.' || newName === '..' || /[\\/]/.test(newName)) {
    throw new Error('new name must be one workspace entry name without path separators');
  }
}

export async function renameHostWorkspaceEntry(
  root: string,
  path: string,
  newName: string,
): Promise<RunnerResult<'workspace.rename'>> {
  try {
    validateRename(path, newName);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    if (requested === realRoot) throw new Error('workspace root cannot be renamed');
    const parent = await realpath(dirname(requested));
    if (!confined(realRoot, parent)) throw new Error('symlink escapes the workspace');
    const source = resolve(parent, basename(requested));
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) throw new Error('workspace symlinks cannot be renamed');
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('path is not a regular file or directory');
    const destination = resolve(parent, newName);
    try {
      await lstat(destination);
      throw new Error('destination already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await rename(source, destination);
    return { ok: true, path: relative(realRoot, destination).split(sep).join('/') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const renameContainerEntry: ContainerRename = async (containerId, root, path, newName) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
source="$root/$2"
parent=$(readlink -f -- "\${source%/*}")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ "$source" != "$root" ] || { echo 'workspace root cannot be renamed' >&2; exit 43; }
[ ! -L "$source" ] || { echo 'workspace symlinks cannot be renamed' >&2; exit 44; }
[ -f "$source" ] || [ -d "$source" ] || { echo 'path is not a regular file or directory' >&2; exit 45; }
destination="$parent/$3"
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'destination already exists' >&2; exit 46; }
mv -- "$source" "$destination"`;
  await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, path, newName]);
};

export async function renameWorkspaceEntry(
  p: RunnerParams<'workspace.rename'>,
  renameContainer: ContainerRename = renameContainerEntry,
): Promise<RunnerResult<'workspace.rename'>> {
  try {
    validateRename(p.path, p.newName);
    if (!p.containerId) return renameHostWorkspaceEntry(p.root, p.path, p.newName);
    await renameContainer(p.containerId, p.root, p.path, p.newName);
    const parent = p.path.split(/[\\/]/).slice(0, -1).join('/');
    return { ok: true, path: parent ? `${parent}/${p.newName}` : p.newName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
