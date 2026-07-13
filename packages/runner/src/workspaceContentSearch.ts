import { execFile } from 'node:child_process';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerParams, RunnerResult } from '@co/protocol';

export const WORKSPACE_CONTENT_MAX_MATCHES = 100;
export const WORKSPACE_CONTENT_MAX_ENTRIES = 10_000;
// Keep every returned file within the web preview limit so each result remains navigable.
export const WORKSPACE_CONTENT_MAX_FILE_BYTES = 512 * 1024;
const CONTAINER_SEARCH_MAX_BUFFER = 1024 * 1024;
const run = promisify(execFile);

type Match = NonNullable<RunnerResult<'workspace.searchContent'>['matches']>[number];
type SearchOutput = { matches: Match[]; truncated: boolean };
type ContainerSearch = (containerId: string, root: string, query: string) => Promise<SearchOutput>;

function confined(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function preview(line: string): string {
  return line.trim().slice(0, 300);
}

export async function searchHostWorkspaceContent(
  root: string,
  query: string,
  maxEntries = WORKSPACE_CONTENT_MAX_ENTRIES,
): Promise<RunnerResult<'workspace.searchContent'>> {
  try {
    const realRoot = await realpath(root);
    const needle = query.toLocaleLowerCase();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const pending = [realRoot];
    const matches: Match[] = [];
    let visited = 0;
    let truncated = false;

    while (pending.length > 0 && !truncated) {
      const directoryPath = pending.pop()!;
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        visited += 1;
        if (visited > maxEntries) { truncated = true; break; }
        const candidate = resolve(directoryPath, entry.name);
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || !confined(realRoot, candidate)) continue;
        if (info.isDirectory()) { pending.push(candidate); continue; }
        if (!info.isFile() || info.size > WORKSPACE_CONTENT_MAX_FILE_BYTES) continue;
        const bytes = await readFile(candidate);
        if (bytes.includes(0)) continue;
        let text: string;
        try { text = decoder.decode(bytes); } catch { continue; }
        const path = relative(realRoot, candidate).split(sep).join('/');
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!line.toLocaleLowerCase().includes(needle)) continue;
          matches.push({ path, line: index + 1, preview: preview(line) });
          if (matches.length >= WORKSPACE_CONTENT_MAX_MATCHES) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }
    matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return { ok: true, matches, truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const searchContainerWorkspaceContent: ContainerSearch = async (containerId, root, query) => {
  const script = String.raw`set -eu
root=$(readlink -f -- "$1")
results=/tmp/co-content-search-$$
trap 'rm -f "$results"' EXIT
visited=0
matched=0
truncated=0
walk() {
  for candidate in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    visited=$((visited + 1))
    if [ "$visited" -gt ${WORKSPACE_CONTENT_MAX_ENTRIES} ]; then truncated=1; return; fi
    [ ! -L "$candidate" ] || continue
    if [ -d "$candidate" ]; then walk "$candidate"; [ "$truncated" -eq 0 ] || return; continue; fi
    [ -f "$candidate" ] || continue
    size=$(wc -c < "$candidate")
    [ "$size" -le ${WORKSPACE_CONTENT_MAX_FILE_BYTES} ] || continue
    rel=\${candidate#"$root"/}
    remaining=$(( ${WORKSPACE_CONTENT_MAX_MATCHES} - matched ))
    grep -I -i -F -n -m "$remaining" -- "$2" "$candidate" > "$results" 2>/dev/null || true
    while IFS= read -r result; do
      line=\${result%%:*}
      text=\${result#*:}
      text=$(printf '%.300s' "$text")
      printf '%s\0%s\0%s\0' "$rel" "$line" "$text"
      matched=$((matched + 1))
      if [ "$matched" -ge ${WORKSPACE_CONTENT_MAX_MATCHES} ]; then truncated=1; return; fi
    done < "$results"
  done
}
walk "$root"
printf '%s\0' "$truncated"`;
  const { stdout } = await run('docker', ['exec', containerId, 'sh', '-c', script, 'sh', root, query], {
    encoding: 'buffer', maxBuffer: CONTAINER_SEARCH_MAX_BUFFER,
  });
  const fields = stdout.toString('utf8').split('\0');
  const traversalTruncated = fields.pop() === '' ? fields.pop() === '1' : false;
  const matches: Match[] = [];
  for (let index = 0; index + 2 < fields.length && matches.length < WORKSPACE_CONTENT_MAX_MATCHES; index += 3) {
    const [path, rawLine, text] = fields.slice(index, index + 3);
    const line = Number(rawLine);
    if (path && Number.isInteger(line) && line > 0 && text !== undefined) matches.push({ path, line, preview: text });
  }
  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { matches, truncated: traversalTruncated || fields.length / 3 > WORKSPACE_CONTENT_MAX_MATCHES };
};

export async function searchWorkspaceContent(
  params: RunnerParams<'workspace.searchContent'>,
  searchContainer: ContainerSearch = searchContainerWorkspaceContent,
): Promise<RunnerResult<'workspace.searchContent'>> {
  if (!params.containerId) return searchHostWorkspaceContent(params.root, params.query);
  try {
    return { ok: true, ...await searchContainer(params.containerId, params.root, params.query) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
