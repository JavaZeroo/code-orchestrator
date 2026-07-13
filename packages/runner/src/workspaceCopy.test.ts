import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyHostWorkspaceEntry, copyWorkspaceEntry } from './workspaceCopy';

describe('copyHostWorkspaceEntry', () => {
  it('copies a regular file without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-copy-'));
    await mkdir(join(root, 'reports'));
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'reports', 'draft.txt'), 'unchanged contents');

    await expect(copyHostWorkspaceEntry(root, 'reports/draft.txt', 'archive/draft.txt'))
      .resolves.toEqual({ ok: true, path: 'archive/draft.txt' });
    await expect(readFile(join(root, 'archive', 'draft.txt'), 'utf8')).resolves.toBe('unchanged contents');
    await expect(readFile(join(root, 'reports', 'draft.txt'), 'utf8')).resolves.toBe('unchanged contents');
  });

  it('copies a directory tree with nested contents intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-copy-'));
    await mkdir(join(root, 'reports', 'draft', 'nested'), { recursive: true });
    await writeFile(join(root, 'reports', 'draft', 'nested', 'result.txt'), 'nested payload');

    await expect(copyHostWorkspaceEntry(root, 'reports/draft', 'reports-copy'))
      .resolves.toEqual({ ok: true, path: 'reports-copy' });
    await expect(readFile(join(root, 'reports-copy', 'nested', 'result.txt'), 'utf8')).resolves.toBe('nested payload');
    await expect(access(join(root, 'reports', 'draft', 'nested', 'result.txt'))).resolves.toBeUndefined();
  });

  it('rejects traversal, collisions, nested destinations, and symlinks without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-copy-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-copy-outside-'));
    await mkdir(join(root, 'reports', 'tree'), { recursive: true });
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'reports', 'tree', 'draft.txt'), 'source');
    await writeFile(join(root, 'archive', 'draft.txt'), 'existing');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'reports', 'tree', 'link.txt'));
    await symlink(outside, join(root, 'escape'));

    const attempts: Array<[string, string]> = [
      ['../secret.txt', 'archive/secret.txt'],
      ['reports/tree/draft.txt', '../outside.txt'],
      ['.', 'archive/root'],
      ['reports/tree/draft.txt', 'archive/draft.txt'],
      ['reports/tree', 'reports/tree/copy'],
      ['reports/tree', 'archive/tree'],
      ['escape/secret.txt', 'archive/secret.txt'],
      ['reports/tree/draft.txt', 'escape/draft.txt'],
    ];
    for (const [path, destinationPath] of attempts) {
      expect((await copyHostWorkspaceEntry(root, path, destinationPath)).ok, `${path} -> ${destinationPath}`).toBe(false);
    }
    await expect(readFile(join(root, 'reports', 'tree', 'draft.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(root, 'archive', 'draft.txt'), 'utf8')).resolves.toBe('existing');
  });
});

describe('copyWorkspaceEntry', () => {
  it('forwards a confined copy to the container boundary', async () => {
    const copyContainer = vi.fn().mockResolvedValue(undefined);
    await expect(copyWorkspaceEntry({
      root: '/workspace', path: 'reports/draft', destinationPath: 'archive/draft', containerId: 'container-1',
    }, copyContainer)).resolves.toEqual({ ok: true, path: 'archive/draft' });
    expect(copyContainer).toHaveBeenCalledWith('container-1', '/workspace', 'reports/draft', 'archive/draft');
  });

  it('rejects traversal and root copies before invoking the container boundary', async () => {
    const copyContainer = vi.fn();
    await expect(copyWorkspaceEntry({
      root: '/workspace', path: '../secret', destinationPath: 'archive/secret', containerId: 'container-1',
    }, copyContainer)).resolves.toMatchObject({ ok: false });
    await expect(copyWorkspaceEntry({
      root: '/workspace', path: 'reports/draft', destinationPath: '.', containerId: 'container-1',
    }, copyContainer)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('root') });
    expect(copyContainer).not.toHaveBeenCalled();
  });
});
