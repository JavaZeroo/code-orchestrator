import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { searchHostWorkspace, searchWorkspace, WORKSPACE_SEARCH_MAX_MATCHES } from './workspaceSearch';

describe('searchHostWorkspace', () => {
  it('recursively returns relative file and directory paths matching the filename query', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-search-'));
    await mkdir(join(root, 'reports', 'final-report'), { recursive: true });
    await writeFile(join(root, 'reports', 'final-report.md'), 'ready');
    await writeFile(join(root, 'reports', 'notes.txt'), 'ignore');

    await expect(searchHostWorkspace(root, 'REPORT')).resolves.toEqual({
      ok: true,
      matches: [
        { path: 'reports', type: 'directory' },
        { path: 'reports/final-report', type: 'directory' },
        { path: 'reports/final-report.md', type: 'file', size: 5 },
      ],
      truncated: false,
    });
  });

  it('does not follow symlinks and bounds the number of returned matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-search-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-outside-'));
    await writeFile(join(outside, 'secret-match.txt'), 'secret');
    await symlink(outside, join(root, 'escaped-match'));
    for (let index = 0; index <= WORKSPACE_SEARCH_MAX_MATCHES; index += 1) {
      await writeFile(join(root, `match-${String(index).padStart(3, '0')}.txt`), 'x');
    }

    const result = await searchHostWorkspace(root, 'match');
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.matches).toHaveLength(WORKSPACE_SEARCH_MAX_MATCHES);
    expect(result.matches).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining('escaped') }));
    expect(result.matches).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining('secret') }));
  });
});

describe('searchWorkspace', () => {
  it('passes container-aware workspace parameters to the container search', async () => {
    const searchContainer = vi.fn().mockResolvedValue({
      matches: [{ path: 'out/model.bin', type: 'file', size: 12 }],
      truncated: false,
    });
    await expect(searchWorkspace({
      root: '/workspace', query: 'model', containerId: 'container-1',
    }, searchContainer)).resolves.toEqual({
      ok: true, matches: [{ path: 'out/model.bin', type: 'file', size: 12 }], truncated: false,
    });
    expect(searchContainer).toHaveBeenCalledWith('container-1', '/workspace', 'model');
  });
});
