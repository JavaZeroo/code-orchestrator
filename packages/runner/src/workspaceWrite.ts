import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { RunnerParams, RunnerResult } from '@co/protocol';
import { WORKSPACE_FILE_MAX_BYTES } from './workspaceFile';

type ContainerWrite = (containerId: string, root: string, path: string, data: Buffer) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

function decodePayload(data: string, size: number): Buffer {
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length !== size) throw new Error('payload size does not match decoded data');
  if (decoded.length > WORKSPACE_FILE_MAX_BYTES) {
    throw new Error(`file exceeds the ${WORKSPACE_FILE_MAX_BYTES}-byte limit`);
  }
  return decoded;
}

export async function writeHostWorkspaceFile(
  root: string,
  path: string,
  data: Buffer,
): Promise<RunnerResult<'workspace.write'>> {
  try {
    validateRelativePath(path);
    if (data.length > WORKSPACE_FILE_MAX_BYTES) throw new Error(`file exceeds the ${WORKSPACE_FILE_MAX_BYTES}-byte limit`);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    const parent = await realpath(dirname(requested));
    if (!confined(realRoot, parent)) throw new Error('symlink escapes the workspace');
    const target = resolve(parent, basename(requested));
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('destination cannot be a symlink');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return { ok: true, size: data.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const writeContainerFile: ContainerWrite = async (containerId, root, path, data) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
target="$root/$2"
parent=$(readlink -f -- "\${target%/*}")
case "$parent/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ ! -L "$target" ] || { echo 'destination cannot be a symlink' >&2; exit 43; }
[ ! -e "$target" ] || [ -f "$target" ] || { echo 'destination is not a regular file' >&2; exit 44; }
tmp="$parent/.co-upload.$$"
trap 'rm -f "$tmp"' EXIT
umask 077
cat > "$tmp"
mv -f "$tmp" "$target"
trap - EXIT`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('docker', ['exec', '-i', containerId, 'sh', '-c', script, 'sh', root, path], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `docker exec exited ${code}`)));
    child.stdin.end(data);
  });
};

export async function writeWorkspaceFile(
  p: RunnerParams<'workspace.write'>,
  writeContainer: ContainerWrite = writeContainerFile,
): Promise<RunnerResult<'workspace.write'>> {
  try {
    validateRelativePath(p.path);
    const data = decodePayload(p.data, p.size);
    if (!p.containerId) return writeHostWorkspaceFile(p.root, p.path, data);
    await writeContainer(p.containerId, p.root, p.path, data);
    return { ok: true, size: data.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
