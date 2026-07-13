import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_MAX_ENTRIES = 1_000;
const run = promisify(execFile);

type ArchiveEntry = { archivePath: string; sourcePath: string; directory: boolean; size: number; mtime: Date };
type ContainerCopy = (containerId: string, root: string, path: string, target: string) => Promise<void>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateDirectoryPath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
  if (path.split(/[\\/]+/).every((part) => !part || part === '.')) {
    throw new Error('workspace root cannot be archived');
  }
}

async function ensureNoSymlinkPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split(/[\\/]+/).filter((value) => value && value !== '.')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('workspace symlinks cannot be archived');
  }
}

async function collectEntries(source: string, archiveRoot: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let totalBytes = 0;

  async function visit(sourcePath: string, archivePath: string): Promise<void> {
    const stat = await lstat(sourcePath);
    if (stat.isSymbolicLink()) throw new Error('workspace symlinks cannot be archived');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('archive contains a non-regular entry');
    if (entries.length >= WORKSPACE_ARCHIVE_MAX_ENTRIES) {
      throw new Error(`archive exceeds the ${WORKSPACE_ARCHIVE_MAX_ENTRIES}-entry limit`);
    }
    if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > WORKSPACE_ARCHIVE_MAX_BYTES) {
        throw new Error(`archive contents exceed the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
      }
    }
    entries.push({ archivePath, sourcePath, directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime });
    if (!stat.isDirectory()) return;
    for (const name of (await readdir(sourcePath)).sort()) {
      await visit(join(sourcePath, name), `${archivePath}/${name}`);
    }
  }

  await visit(source, archiveRoot);
  return entries;
}

function writeField(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error('archive path is too long for tar format');
  bytes.copy(header, offset);
}

function octal(value: number, length: number): string {
  const encoded = Math.max(0, Math.floor(value)).toString(8);
  if (encoded.length > length - 1) throw new Error('archive metadata exceeds tar limits');
  return `${encoded.padStart(length - 1, '0')}\0`;
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new Error('archive path is too long for tar format');
}

function tarHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entry.archivePath);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(entry.directory ? 0o755 : 0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(entry.directory ? 0 : entry.size, 12));
  writeField(header, 136, 12, octal(entry.mtime.getTime() / 1_000, 12));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, entry.directory ? '5' : '0');
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

async function createTar(entries: ArchiveEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let actualBytes = 0;
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    if (entry.directory) continue;
    const handle = await open(entry.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const data = await handle.readFile();
      actualBytes += data.length;
      if (data.length !== entry.size) throw new Error('archive contents changed while being read');
      if (actualBytes > WORKSPACE_ARCHIVE_MAX_BYTES) {
        throw new Error(`archive contents exceed the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
      }
      chunks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    } finally {
      await handle.close();
    }
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks);
}

export async function archiveHostWorkspaceDirectory(
  root: string,
  path: string,
): Promise<RunnerResult<'workspace.archive'>> {
  try {
    validateDirectoryPath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    await ensureNoSymlinkPath(realRoot, path);
    if (!(await lstat(requested)).isDirectory()) throw new Error('path is not a directory');
    const directoryName = basename(requested);
    const entries = await collectEntries(requested, directoryName);
    const archive = gzipSync(await createTar(entries));
    if (archive.length > WORKSPACE_ARCHIVE_MAX_BYTES) {
      throw new Error(`archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
    }
    return {
      ok: true,
      basename: `${directoryName}.tar.gz`,
      size: archive.length,
      data: archive.toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const containerWorkspaceArchiveValidationScript = String.raw`set -eu
root=$(readlink -f -- "$1")
current=$root
remaining=$2
while [ -n "$remaining" ]; do
  part=\${remaining%%/*}
  if [ -n "$part" ] && [ "$part" != "." ]; then
    current="$current/$part"
    [ ! -L "$current" ] || { echo 'workspace symlinks cannot be archived' >&2; exit 46; }
  fi
  case "$remaining" in
    */*) remaining=\${remaining#*/} ;;
    *) remaining= ;;
  esac
done
requested=$(readlink -f -- "$root/$2")
case "$requested/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ -d "$requested" ] || { echo 'path is not a directory' >&2; exit 43; }
[ -z "$(find "$requested" -type l -print -quit)" ] || { echo 'workspace symlinks cannot be archived' >&2; exit 46; }
[ -z "$(find "$requested" ! -type f ! -type d ! -type l -print -quit)" ] || { echo 'archive contains a non-regular entry' >&2; exit 47; }
entry_count=$(find "$requested" -exec sh -c 'for entry do printf x; done' sh {} + | wc -c)
[ "$entry_count" -le ${WORKSPACE_ARCHIVE_MAX_ENTRIES} ] || { echo 'archive exceeds the ${WORKSPACE_ARCHIVE_MAX_ENTRIES}-entry limit' >&2; exit 48; }
content_bytes=$(find "$requested" -type f -exec sh -c 'for file do wc -c < "$file"; done' sh {} + | awk '{ total += $1 } END { print total + 0 }')
[ "$content_bytes" -le ${WORKSPACE_ARCHIVE_MAX_BYTES} ] || { echo 'archive contents exceed the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit' >&2; exit 49; }`;

const copyContainerDirectory: ContainerCopy = async (containerId, root, path, target) => {
  await run('docker', ['exec', containerId, 'sh', '-c', containerWorkspaceArchiveValidationScript, 'sh', root, path]);
  await run('docker', ['cp', `${containerId}:${resolve(root, path)}`, target], { maxBuffer: 1024 * 1024 });
};

export async function archiveWorkspaceDirectory(
  params: RunnerParams<'workspace.archive'>,
  copyContainer: ContainerCopy = copyContainerDirectory,
): Promise<RunnerResult<'workspace.archive'>> {
  if (!params.containerId) return archiveHostWorkspaceDirectory(params.root, params.path);
  try {
    validateDirectoryPath(params.path);
    const temp = await mkdtemp(`${tmpdir()}/co-workspace-archive-`);
    const target = resolve(temp, basename(params.path));
    try {
      await copyContainer(params.containerId, params.root, params.path, target);
      return await archiveHostWorkspaceDirectory(temp, basename(params.path));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
