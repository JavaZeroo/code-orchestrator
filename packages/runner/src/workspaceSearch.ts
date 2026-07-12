import { execFile } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_SEARCH_MAX_MATCHES = 100;
export const WORKSPACE_SEARCH_MAX_ENTRIES = 10_000;
const CONTAINER_SEARCH_MAX_BUFFER = 1024 * 1024;
const run = promisify(execFile);

type SearchMatch = NonNullable<RunnerResult<'workspace.search'>['matches']>[number];
type SearchOutput = { matches: SearchMatch[]; truncated: boolean };
type ContainerSearch = (containerId: string, root: string, query: string) => Promise<SearchOutput>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sorted(output: SearchOutput): SearchOutput {
  output.matches.sort((a, b) => a.path.localeCompare(b.path));
  return output;
}

export async function searchHostWorkspace(root: string, query: string): Promise<RunnerResult<'workspace.search'>> {
  try {
    const realRoot = await realpath(root);
    const needle = query.toLocaleLowerCase();
    const matches: SearchMatch[] = [];
    const pending = [realRoot];
    let visited = 0;
    let truncated = false;

    while (pending.length > 0 && !truncated) {
      const directoryPath = pending.pop()!;
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        visited += 1;
        if (visited > WORKSPACE_SEARCH_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const candidate = resolve(directoryPath, entry.name);
        const info = await lstat(candidate);
        // Search never follows symlinks, so an entry cannot leave the workspace or create a cycle.
        if (info.isSymbolicLink() || !confined(realRoot, candidate)) continue;
        const path = relative(realRoot, candidate).split(sep).join('/');
        const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
        if (!type) continue;
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          matches.push(type === 'file' ? { path, type, size: info.size } : { path, type });
          if (matches.length >= WORKSPACE_SEARCH_MAX_MATCHES) {
            truncated = true;
            break;
          }
        }
        if (type === 'directory') pending.push(candidate);
      }
    }
    return { ok: true, ...sorted({ matches, truncated }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const searchContainerWorkspace: ContainerSearch = async (containerId, root, query) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
needle=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
visited=0
matched=0
truncated=0
walk() {
  for candidate in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    visited=$((visited + 1))
    if [ "$visited" -gt ${WORKSPACE_SEARCH_MAX_ENTRIES} ]; then truncated=1; return; fi
    [ ! -L "$candidate" ] || continue
    name=\${candidate##*/}
    rel=\${candidate#"$root"/}
    type=
    size=
    if [ -d "$candidate" ]; then type=directory
    elif [ -f "$candidate" ]; then type=file; size=$(wc -c < "$candidate")
    else continue
    fi
    lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      *"$needle"*)
        printf '%s\0%s\0%s\0' "$rel" "$type" "$size"
        matched=$((matched + 1))
        if [ "$matched" -ge ${WORKSPACE_SEARCH_MAX_MATCHES} ]; then truncated=1; return; fi
        ;;
    esac
    if [ "$type" = directory ]; then walk "$candidate"; [ "$truncated" -eq 0 ] || return; fi
  done
}
walk "$root"
printf '%s\0' "$truncated"`;
  const { stdout } = await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, query], {
    encoding: 'buffer', maxBuffer: CONTAINER_SEARCH_MAX_BUFFER,
  });
  const fields = stdout.toString('utf8').split('\0');
  const truncated = fields.pop() === '' ? fields.pop() === '1' : false;
  const matches: SearchMatch[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, type, rawSize] = fields.slice(i, i + 3);
    if (!path || (type !== 'file' && type !== 'directory')) continue;
    matches.push(type === 'file' ? { path, type, size: Number(rawSize) } : { path, type });
  }
  return sorted({ matches, truncated });
};

export async function searchWorkspace(
  p: RunnerParams<'workspace.search'>,
  searchContainer: ContainerSearch = searchContainerWorkspace,
): Promise<RunnerResult<'workspace.search'>> {
  if (!p.containerId) return searchHostWorkspace(p.root, p.query);
  try {
    return { ok: true, ...await searchContainer(p.containerId, p.root, p.query) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
