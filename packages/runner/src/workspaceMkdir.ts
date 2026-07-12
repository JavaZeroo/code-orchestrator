import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
type ContainerMkdir = (containerId: string, root: string, path: string) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

export async function createHostWorkspaceDirectory(root: string, path: string): Promise<RunnerResult<'workspace.mkdir'>> {
  try {
    validateRelativePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    if (requested === realRoot) throw new Error('workspace root already exists');
    const parent = await realpath(dirname(requested));
    if (!confined(realRoot, parent)) throw new Error('symlink escapes the workspace');
    await mkdir(resolve(parent, basename(requested)), { mode: 0o700 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const createContainerDirectory: ContainerMkdir = async (containerId, root, path) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
target="$root/$2"
parent=$(readlink -f -- "\${target%/*}")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'destination already exists' >&2; exit 43; }
umask 077
mkdir -- "$target"`;
  await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, path]);
};

export async function createWorkspaceDirectory(
  p: RunnerParams<'workspace.mkdir'>,
  mkdirContainer: ContainerMkdir = createContainerDirectory,
): Promise<RunnerResult<'workspace.mkdir'>> {
  try {
    validateRelativePath(p.path);
    if (!p.containerId) return createHostWorkspaceDirectory(p.root, p.path);
    await mkdirContainer(p.containerId, p.root, p.path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
