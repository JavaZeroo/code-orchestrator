import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

const run = promisify(execFile);
type ContainerChmod = (containerId: string, root: string, path: string, executable: boolean) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

export async function chmodHostWorkspaceFile(
  root: string,
  path: string,
  executable: boolean,
): Promise<RunnerResult<'workspace.chmod'>> {
  try {
    validateRelativePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    const parent = await realpath(dirname(requested));
    if (!confined(realRoot, parent)) throw new Error('symlink escapes the workspace');
    const target = resolve(parent, basename(requested));
    if ((await lstat(target)).isSymbolicLink()) throw new Error('workspace symlinks cannot be changed');

    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const targetStat = await handle.stat();
      if (!targetStat.isFile()) throw new Error('path is not a regular file');
      const mode = executable ? targetStat.mode | 0o111 : targetStat.mode & ~0o111;
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    return { ok: true, executable };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const containerWorkspaceChmodScript = String.raw`set -eu
root=$(readlink -f -- "$1")
target="$root/$2"
parent=$(readlink -f -- "$(dirname -- "$target")")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
target="$parent/$(basename -- "$target")"
[ ! -L "$target" ] || { echo 'workspace symlinks cannot be changed' >&2; exit 43; }
canonical=$(readlink -f -- "$target") || { echo 'path is not a regular file' >&2; exit 44; }
case "$canonical/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ -f "$target" ] || { echo 'path is not a regular file' >&2; exit 44; }
if [ "$3" = true ]; then
  chmod a+x -- "$target"
else
  chmod a-x -- "$target"
fi`;

const chmodContainerFile: ContainerChmod = async (containerId, root, path, executable) => {
  await run('docker', [
    'exec', containerId, 'sh', '-c', containerWorkspaceChmodScript, 'sh', root, path, String(executable),
  ]);
};

export async function chmodWorkspaceFile(
  p: RunnerParams<'workspace.chmod'>,
  chmodContainer: ContainerChmod = chmodContainerFile,
): Promise<RunnerResult<'workspace.chmod'>> {
  try {
    validateRelativePath(p.path);
    if (!p.containerId) return chmodHostWorkspaceFile(p.root, p.path, p.executable);
    await chmodContainer(p.containerId, p.root, p.path, p.executable);
    return { ok: true, executable: p.executable };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
