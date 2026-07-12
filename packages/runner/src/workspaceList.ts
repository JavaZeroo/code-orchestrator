import { execFile } from 'node:child_process';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_LIST_MAX_ENTRIES = 200;
const CONTAINER_LIST_MAX_BUFFER = 1024 * 1024;
const run = promisify(execFile);

type WorkspaceEntry = NonNullable<RunnerResult<'workspace.list'>['entries']>[number];
type ContainerList = (containerId: string, root: string, path: string) => Promise<WorkspaceEntry[]>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative and cannot traverse the workspace');
  }
}

function sortAndBound(entries: WorkspaceEntry[]): Pick<RunnerResult<'workspace.list'>, 'entries' | 'truncated'> {
  entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
  return { entries: entries.slice(0, WORKSPACE_LIST_MAX_ENTRIES), truncated: entries.length > WORKSPACE_LIST_MAX_ENTRIES };
}

export async function listHostWorkspaceDirectory(root: string, path: string): Promise<RunnerResult<'workspace.list'>> {
  try {
    validateRelativePath(path);
    const realRoot = await realpath(root);
    const requested = resolve(realRoot, path || '.');
    if (!confined(realRoot, requested)) throw new Error('path escapes the workspace');
    const resolvedDirectory = await realpath(requested);
    if (!confined(realRoot, resolvedDirectory)) throw new Error('symlink escapes the workspace');
    if (!(await stat(resolvedDirectory)).isDirectory()) throw new Error('path is not a directory');

    const entries: WorkspaceEntry[] = [];
    const directory = await opendir(resolvedDirectory);
    for await (const entry of directory) {
      const requestedEntry = resolve(resolvedDirectory, entry.name);
      let resolvedEntry: string;
      try {
        resolvedEntry = await realpath(requestedEntry);
      } catch {
        continue;
      }
      // Escaped symlinks and non-regular filesystem objects are not discoverable.
      if (!confined(realRoot, resolvedEntry)) continue;
      const entryStat = entry.isSymbolicLink() ? await stat(resolvedEntry) : await lstat(requestedEntry);
      if (entryStat.isDirectory()) entries.push({ name: entry.name, type: 'directory' });
      else if (entryStat.isFile()) entries.push({ name: entry.name, type: 'file', size: entryStat.size });
      if (entries.length > WORKSPACE_LIST_MAX_ENTRIES) break;
    }
    return { ok: true, path, ...sortAndBound(entries) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const listContainerDirectory: ContainerList = async (containerId, root, path) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
requested=$(readlink -f -- "$root/\${2:-.}")
case "$requested/" in "$root/"*) ;; *) echo 'path escapes the workspace' >&2; exit 42;; esac
[ -d "$requested" ] || { echo 'path is not a directory' >&2; exit 43; }
count=0
for candidate in "$requested"/* "$requested"/.[!.]* "$requested"/..?*; do
  [ -e "$candidate" ] || [ -L "$candidate" ] || continue
  resolved=$(readlink -f -- "$candidate") || continue
  case "$resolved/" in "$root/"*) ;; *) continue;; esac
  name=\${candidate##*/}
  if [ -d "$resolved" ]; then
    printf "%s\\0directory\\0\\0" "$name"
  elif [ -f "$resolved" ]; then
    size=$(wc -c < "$resolved")
    printf "%s\\0file\\0%s\\0" "$name" "$size"
  else
    continue
  fi
  count=$((count + 1))
  [ "$count" -le ${WORKSPACE_LIST_MAX_ENTRIES} ] || break
done`;
  const { stdout } = await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, path], {
    encoding: 'buffer', maxBuffer: CONTAINER_LIST_MAX_BUFFER,
  });
  const fields = stdout.toString('utf8').split('\0');
  const entries: WorkspaceEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [name, type, rawSize] = fields.slice(i, i + 3);
    if (!name || (type !== 'file' && type !== 'directory')) continue;
    entries.push(type === 'file' ? { name, type, size: Number(rawSize) } : { name, type });
  }
  return entries;
};

export async function listWorkspaceDirectory(
  p: RunnerParams<'workspace.list'>,
  listContainer: ContainerList = listContainerDirectory,
): Promise<RunnerResult<'workspace.list'>> {
  if (!p.containerId) return listHostWorkspaceDirectory(p.root, p.path);
  try {
    validateRelativePath(p.path);
    const entries = await listContainer(p.containerId, p.root, p.path);
    return { ok: true, path: p.path, ...sortAndBound(entries) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
