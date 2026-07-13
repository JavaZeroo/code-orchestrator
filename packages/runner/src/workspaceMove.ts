import { execFile } from 'node:child_process';
import { lstat, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
type ContainerMove = (containerId: string, root: string, path: string, destinationPath: string) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validatePath(path: string, label: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} must be relative and cannot traverse the workspace`);
  }
  if (path.split(/[\\/]+/).every((part) => !part || part === '.')) {
    throw new Error('workspace root cannot be moved');
  }
}

function validateMove(path: string, destinationPath: string): void {
  validatePath(path, 'path');
  validatePath(destinationPath, 'destination path');
}

async function ensureNoSymlinkPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split(/[\\/]+/).filter((value) => value && value !== '.')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('workspace symlinks cannot be moved');
  }
}

export async function moveHostWorkspaceEntry(
  root: string,
  path: string,
  destinationPath: string,
): Promise<RunnerResult<'workspace.move'>> {
  try {
    validateMove(path, destinationPath);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    const requestedDestination = resolve(realRoot, destinationPath);
    if (!confined(realRoot, requested) || !confined(realRoot, requestedDestination)) {
      throw new Error('path escapes the workspace');
    }
    if (requested === realRoot || requestedDestination === realRoot) throw new Error('workspace root cannot be moved');

    await ensureNoSymlinkPath(realRoot, path);
    const sourceParent = await realpath(dirname(requested));
    const destinationParent = await realpath(dirname(requestedDestination));
    if (!confined(realRoot, sourceParent) || !confined(realRoot, destinationParent)) {
      throw new Error('symlink escapes the workspace');
    }
    const destinationParentPath = relative(realRoot, dirname(requestedDestination));
    if (destinationParentPath) await ensureNoSymlinkPath(realRoot, destinationParentPath);

    const source = resolve(sourceParent, basename(requested));
    const destination = resolve(destinationParent, basename(requestedDestination));
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) throw new Error('workspace symlinks cannot be moved');
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('path is not a regular file or directory');
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

const moveContainerEntry: ContainerMove = async (containerId, root, path, destinationPath) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
source="$root/$2"
destination="$root/$3"
check_no_symlinks() {
  relative_path=$1
  current=$root
  old_ifs=$IFS
  IFS=/
  set -- $relative_path
  IFS=$old_ifs
  for part do
    [ -n "$part" ] && [ "$part" != "." ] || continue
    current="$current/$part"
    [ ! -L "$current" ] || { echo 'workspace symlinks cannot be moved' >&2; exit 45; }
  done
}
check_no_symlinks "$2"
check_no_symlinks "\${3%/*}"
source_parent=$(readlink -f -- "\${source%/*}")
destination_parent=$(readlink -f -- "\${destination%/*}")
case "$source_parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
case "$destination_parent/" in "$root/"*) ;; *) echo 'destination path escapes the workspace' >&2; exit 43;; esac
[ "$source" != "$root" ] && [ "$destination" != "$root" ] || { echo 'workspace root cannot be moved' >&2; exit 44; }
[ ! -L "$source" ] && [ ! -L "$destination_parent" ] || { echo 'workspace symlinks cannot be moved' >&2; exit 45; }
[ -f "$source" ] || [ -d "$source" ] || { echo 'path is not a regular file or directory' >&2; exit 46; }
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'destination already exists' >&2; exit 47; }
mv -- "$source" "$destination"`;
  await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, path, destinationPath]);
};

export async function moveWorkspaceEntry(
  params: RunnerParams<'workspace.move'>,
  moveContainer: ContainerMove = moveContainerEntry,
): Promise<RunnerResult<'workspace.move'>> {
  try {
    validateMove(params.path, params.destinationPath);
    if (!params.containerId) return moveHostWorkspaceEntry(params.root, params.path, params.destinationPath);
    await moveContainer(params.containerId, params.root, params.path, params.destinationPath);
    return { ok: true, path: params.destinationPath.split('\\').join('/') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
