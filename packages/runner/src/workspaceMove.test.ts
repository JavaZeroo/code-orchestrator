import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { moveHostWorkspaceEntry, moveWorkspaceEntry } from './workspaceMove';

describe('moveHostWorkspaceEntry', () => {
  it('moves a regular file to another existing folder and preserves contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-move-'));
    await mkdir(join(root, 'reports'));
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'reports', 'draft.txt'), 'unchanged contents');

    await expect(moveHostWorkspaceEntry(root, 'reports/draft.txt', 'archive/draft.txt'))
      .resolves.toEqual({ ok: true, path: 'archive/draft.txt' });
    await expect(readFile(join(root, 'archive', 'draft.txt'), 'utf8')).resolves.toBe('unchanged contents');
    await expect(access(join(root, 'reports', 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('moves a non-empty directory with nested contents intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-move-'));
    await mkdir(join(root, 'reports', 'draft'), { recursive: true });
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'reports', 'draft', 'nested.txt'), 'nested payload');

    await expect(moveHostWorkspaceEntry(root, 'reports/draft', 'archive/draft'))
      .resolves.toEqual({ ok: true, path: 'archive/draft' });
    await expect(readFile(join(root, 'archive', 'draft', 'nested.txt'), 'utf8')).resolves.toBe('nested payload');
  });

  it('rejects traversal, root moves, missing parents, collisions, and symlinks without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-move-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-move-outside-'));
    await mkdir(join(root, 'reports'));
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'reports', 'draft.txt'), 'source');
    await writeFile(join(root, 'archive', 'draft.txt'), 'existing');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(outside, join(root, 'escape'));

    const attempts: Array<[string, string]> = [
      ['../secret.txt', 'archive/secret.txt'],
      ['reports/draft.txt', '../outside.txt'],
      ['.', 'archive/root'],
      ['reports/draft.txt', '.'],
      ['reports/draft.txt', 'missing/draft.txt'],
      ['reports/draft.txt', 'archive/draft.txt'],
      ['link.txt', 'archive/link.txt'],
      ['escape/secret.txt', 'archive/secret.txt'],
      ['reports/draft.txt', 'escape/draft.txt'],
    ];
    for (const [path, destinationPath] of attempts) {
      expect((await moveHostWorkspaceEntry(root, path, destinationPath)).ok, `${path} -> ${destinationPath}`).toBe(false);
    }
    await expect(readFile(join(root, 'reports', 'draft.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(root, 'archive', 'draft.txt'), 'utf8')).resolves.toBe('existing');
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });
});

describe('moveWorkspaceEntry', () => {
  it('forwards a confined move to the container boundary', async () => {
    const moveContainer = vi.fn().mockResolvedValue(undefined);
    await expect(moveWorkspaceEntry({
      root: '/workspace', path: 'reports/draft', destinationPath: 'archive/draft', containerId: 'container-1',
    }, moveContainer)).resolves.toEqual({ ok: true, path: 'archive/draft' });
    expect(moveContainer).toHaveBeenCalledWith('container-1', '/workspace', 'reports/draft', 'archive/draft');
  });

  it('rejects traversal and root moves before invoking the container boundary', async () => {
    const moveContainer = vi.fn();
    await expect(moveWorkspaceEntry({
      root: '/workspace', path: '../secret', destinationPath: 'archive/secret', containerId: 'container-1',
    }, moveContainer)).resolves.toMatchObject({ ok: false });
    await expect(moveWorkspaceEntry({
      root: '/workspace', path: 'reports/draft', destinationPath: '.', containerId: 'container-1',
    }, moveContainer)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('root') });
    expect(moveContainer).not.toHaveBeenCalled();
  });
});
