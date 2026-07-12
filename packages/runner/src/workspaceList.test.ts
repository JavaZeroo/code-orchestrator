import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listHostWorkspaceDirectory, listWorkspaceDirectory, WORKSPACE_LIST_MAX_ENTRIES } from './workspaceList';

describe('listHostWorkspaceDirectory', () => {
  it('lists directories before regular files with file sizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-list-'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'answer.txt'), 'four');

    await expect(listHostWorkspaceDirectory(root, '')).resolves.toEqual({
      ok: true,
      path: '',
      entries: [
        { name: 'reports', type: 'directory' },
        { name: 'answer.txt', type: 'file', size: 4 },
      ],
      truncated: false,
    });
  });

  it('rejects traversal and escaped directory symlinks and hides escaped entry symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-list-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escaped-dir'));
    await symlink(join(outside, 'secret.txt'), join(root, 'escaped-file'));

    await expect(listHostWorkspaceDirectory(root, '../outside')).resolves.toMatchObject({ ok: false });
    await expect(listHostWorkspaceDirectory(root, 'escaped-dir')).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('symlink escapes'),
    });
    await expect(listHostWorkspaceDirectory(root, '')).resolves.toMatchObject({ ok: true, entries: [] });
  });

  it('caps directory responses and reports truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-list-'));
    await Promise.all(Array.from({ length: WORKSPACE_LIST_MAX_ENTRIES + 1 }, (_, i) =>
      writeFile(join(root, `file-${String(i).padStart(3, '0')}`), 'x')));
    const result = await listHostWorkspaceDirectory(root, '');
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.entries).toHaveLength(WORKSPACE_LIST_MAX_ENTRIES);
  });

  it('uses the container listing boundary and applies the same response cap', async () => {
    const listContainer = async (containerId: string, root: string, path: string) => {
      expect({ containerId, root, path }).toEqual({ containerId: 'c1', root: '/workspace', path: 'out' });
      return Array.from({ length: WORKSPACE_LIST_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `result-${i}.bin`, type: 'file' as const, size: i,
      }));
    };
    const result = await listWorkspaceDirectory({
      root: '/workspace', path: 'out', containerId: 'c1',
    }, listContainer);
    expect(result).toMatchObject({ ok: true, path: 'out', truncated: true });
    expect(result.entries).toHaveLength(WORKSPACE_LIST_MAX_ENTRIES);
  });
});
