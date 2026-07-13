import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { searchHostWorkspaceContent, searchWorkspaceContent, WORKSPACE_CONTENT_MAX_MATCHES } from './workspaceContentSearch';

describe('searchHostWorkspaceContent', () => {
  it('returns case-insensitive literal matches in nested text files with line previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-content-search-'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'notes.txt'), 'first\nRelease [READY].\nlast');
    await expect(searchHostWorkspaceContent(root, '[ready]')).resolves.toEqual({
      ok: true,
      matches: [{ path: 'nested/notes.txt', line: 2, preview: 'Release [READY].' }],
      truncated: false,
    });
  });

  it('skips binary files and symlinks and bounds returned matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-content-search-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-content-outside-'));
    await writeFile(join(root, 'binary.dat'), Buffer.from('needle\0hidden'));
    await writeFile(join(outside, 'secret.txt'), 'needle');
    await symlink(outside, join(root, 'escaped'));
    await writeFile(join(root, 'many.txt'), Array.from({ length: WORKSPACE_CONTENT_MAX_MATCHES + 1 }, () => 'needle').join('\n'));
    const result = await searchHostWorkspaceContent(root, 'needle');
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.matches).toHaveLength(WORKSPACE_CONTENT_MAX_MATCHES);
    expect(result.matches).not.toContainEqual(expect.objectContaining({ path: 'binary.dat' }));
    expect(result.matches).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining('secret') }));
  });

  it('stops traversal at the configured entry bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-content-search-'));
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => writeFile(join(root, name), 'needle')));
    const result = await searchHostWorkspaceContent(root, 'needle', 2);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.matches?.length).toBeLessThanOrEqual(2);
  });
});

describe('searchWorkspaceContent', () => {
  it('executes content search through the session container when present', async () => {
    const searchContainer = vi.fn().mockResolvedValue({
      matches: [{ path: 'src/main.ts', line: 7, preview: 'const ready = true;' }], truncated: false,
    });
    await expect(searchWorkspaceContent({
      root: '/workspace', query: 'READY', containerId: 'container-1',
    }, searchContainer)).resolves.toEqual({
      ok: true, matches: [{ path: 'src/main.ts', line: 7, preview: 'const ready = true;' }], truncated: false,
    });
    expect(searchContainer).toHaveBeenCalledWith('container-1', '/workspace', 'READY');
  });
});
