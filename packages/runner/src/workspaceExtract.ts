import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { RunnerParams, RunnerResult } from '@co/protocol';
import { WORKSPACE_ARCHIVE_MAX_BYTES, WORKSPACE_ARCHIVE_MAX_ENTRIES } from './workspaceArchive';

const MAX_TAR_BYTES = WORKSPACE_ARCHIVE_MAX_BYTES + WORKSPACE_ARCHIVE_MAX_ENTRIES * 1_024 + 1_024;
const run = promisify(execFile);

type ExtractEntry = { path: string; directory: boolean; data: Buffer };
type ContainerExtractor = (params: RunnerParams<'workspace.extract'>) => Promise<number>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateArchivePath(path: string): void {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
  if (!path.toLowerCase().endsWith('.tar.gz')) throw new Error('path must select a .tar.gz archive');
}

async function ensureNoSymlinkPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split(/[\\/]+/).filter((value) => value && value !== '.')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('workspace symlinks cannot be extracted');
  }
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8');
}

function tarNumber(header: Buffer, offset: number, length: number, label: string): number {
  const value = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`archive has invalid ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`archive has invalid ${label}`);
  return parsed;
}

function safeArchivePath(rawPath: string): string {
  if (rawPath.includes('\\') || rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) {
    throw new Error('archive contains an absolute or unsafe path');
  }
  let path = rawPath.replace(/\/+$/, '');
  while (path.startsWith('./')) path = path.slice(2);
  const parts = path.split('/');
  if (!path || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('archive contains a traversal or invalid path');
  }
  return parts.join('/');
}

export function parseWorkspaceArchive(compressed: Buffer): ExtractEntry[] {
  if (compressed.length > WORKSPACE_ARCHIVE_MAX_BYTES) {
    throw new Error(`archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES });
  } catch (error) {
    if (error instanceof Error && /larger than|output length|buffer too large/i.test(error.message)) {
      throw new Error(`archive contents exceed the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
    }
    throw new Error('archive is not a valid gzip-compressed tar file');
  }

  const entries: ExtractEntry[] = [];
  const seen = new Map<string, boolean>();
  let contentBytes = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (entries.length >= WORKSPACE_ARCHIVE_MAX_ENTRIES) {
      throw new Error(`archive exceeds the ${WORKSPACE_ARCHIVE_MAX_ENTRIES}-entry limit`);
    }

    const expectedChecksum = tarNumber(header, 148, 8, 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) throw new Error('archive has an invalid header checksum');

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(path)) throw new Error(`archive contains duplicate path: ${path}`);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === '1' || type === '2') throw new Error('archive links cannot be extracted');
    if (type !== '\0' && type !== '0' && type !== '5') {
      throw new Error('archive contains a non-regular entry');
    }
    const directory = type === '5';
    const size = tarNumber(header, 124, 12, 'entry size');
    if (directory && size !== 0) throw new Error('archive directory has file contents');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('archive entry is truncated');
    if (!directory) {
      contentBytes += size;
      if (contentBytes > WORKSPACE_ARCHIVE_MAX_BYTES) {
        throw new Error(`archive contents exceed the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte limit`);
      }
    }
    entries.push({ path, directory, data: directory ? Buffer.alloc(0) : Buffer.from(tar.subarray(dataStart, dataEnd)) });
    seen.set(path, directory);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error('archive is empty');
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (seen.get(parent) === false) throw new Error(`archive path is nested beneath a file: ${entry.path}`);
    }
  }
  return entries;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeStagingTree(staging: string, entries: ExtractEntry[]): Promise<void> {
  for (const entry of entries.filter((value) => value.directory).sort((a, b) => a.path.length - b.path.length)) {
    await mkdir(join(staging, entry.path), { recursive: true, mode: 0o755 });
  }
  for (const entry of entries.filter((value) => !value.directory)) {
    const target = join(staging, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try {
      await handle.writeFile(entry.data);
    } finally {
      await handle.close();
    }
  }
}

function topLevelNames(entries: ExtractEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.path.split('/')[0]!))].sort();
}

async function commitHostTree(destination: string, staging: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (await pathExists(join(destination, name))) throw new Error(`destination already exists: ${name}`);
  }
  const moved: string[] = [];
  try {
    for (const name of names) {
      await rename(join(staging, name), join(destination, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse()) await rename(join(destination, name), join(staging, name));
    throw error;
  }
}

export async function extractHostWorkspaceArchive(
  root: string,
  path: string,
): Promise<RunnerResult<'workspace.extract'>> {
  let staging: string | undefined;
  try {
    validateArchivePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path);
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    await ensureNoSymlinkPath(realRoot, path);
    const archiveHandle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archive: Buffer;
    try {
      if (!(await archiveHandle.stat()).isFile()) throw new Error('path is not a regular archive file');
      archive = await archiveHandle.readFile();
    } finally {
      await archiveHandle.close();
    }
    const destinationPath = dirname(path);
    if (destinationPath !== '.') await ensureNoSymlinkPath(realRoot, destinationPath);
    const destination = resolve(realRoot, destinationPath);
    if (!confined(realRoot, destination) || !(await stat(destination)).isDirectory()) {
      throw new Error('archive destination is not a workspace directory');
    }
    const entries = parseWorkspaceArchive(archive);
    staging = await mkdtemp(join(destination, '.co-extract-'));
    await writeStagingTree(staging, entries);
    await commitHostTree(destination, staging, topLevelNames(entries));
    return { ok: true, entries: entries.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

const containerArchiveValidationScript = String.raw`set -eu
root=$(readlink -f -- "$1")
current=$root
remaining=$2
while [ -n "$remaining" ]; do
  part=\${remaining%%/*}
  if [ -n "$part" ] && [ "$part" != "." ]; then
    current="$current/$part"
    [ ! -L "$current" ] || { echo 'workspace symlinks cannot be extracted' >&2; exit 46; }
  fi
  case "$remaining" in */*) remaining=\${remaining#*/} ;; *) remaining= ;; esac
done
requested=$(readlink -f -- "$root/$2")
case "$requested/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ -f "$requested" ] || { echo 'path is not a regular archive file' >&2; exit 43; }`;

const containerCommitScript = String.raw`set -eu
destination=$1
staging=$2
shift 2
committed=
rollback() {
  [ "$committed" = yes ] && return
  for name do
    if { [ -e "$destination/$name" ] || [ -L "$destination/$name" ]; } && [ ! -e "$staging/$name" ]; then
      mv -- "$destination/$name" "$staging/$name" || true
    fi
  done
}
trap 'rollback "$@"' EXIT HUP INT TERM
for name do
  [ ! -e "$destination/$name" ] && [ ! -L "$destination/$name" ] || { echo "destination already exists: $name" >&2; exit 44; }
done
for name do
  mv -- "$staging/$name" "$destination/$name"
done
committed=yes
trap - EXIT HUP INT TERM`;

const extractContainerWorkspaceArchive: ContainerExtractor = async (params) => {
  const temp = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
  let containerStaging: string | undefined;
  try {
    const localArchive = join(temp, 'archive.tar.gz');
    const localTree = join(temp, 'tree');
    await mkdir(localTree);
    await run('docker', ['exec', params.containerId!, 'sh', '-c', containerArchiveValidationScript, 'sh', params.root, params.path]);
    await run('docker', ['cp', `${params.containerId}:${resolve(params.root, params.path)}`, localArchive], { maxBuffer: 1024 * 1024 });
    const copiedEntries = parseWorkspaceArchive(await readFile(localArchive));
    await writeStagingTree(localTree, copiedEntries);
    const destination = resolve(params.root, dirname(params.path));
    const created = await run('docker', ['exec', params.containerId!, 'mktemp', '-d', `${destination}/.co-extract-XXXXXX`]);
    containerStaging = created.stdout.trim();
    if (!containerStaging) throw new Error('container extraction staging failed');
    await run('docker', ['cp', `${localTree}/.`, `${params.containerId}:${containerStaging}`], { maxBuffer: 1024 * 1024 });
    await run('docker', ['exec', params.containerId!, 'sh', '-c', containerCommitScript, 'sh', destination, containerStaging, ...topLevelNames(copiedEntries)]);
    return copiedEntries.length;
  } finally {
    if (containerStaging) {
      await run('docker', ['exec', params.containerId!, 'rm', '-rf', '--', containerStaging]).catch(() => undefined);
    }
    await rm(temp, { recursive: true, force: true });
  }
};

export async function extractWorkspaceArchive(
  params: RunnerParams<'workspace.extract'>,
  containerExtractor: ContainerExtractor = extractContainerWorkspaceArchive,
): Promise<RunnerResult<'workspace.extract'>> {
  if (!params.containerId) return extractHostWorkspaceArchive(params.root, params.path);
  try {
    validateArchivePath(params.path);
    const entries = await containerExtractor(params);
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
