import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renameHostWorkspaceEntry, renameWorkspaceEntry } from './workspaceRename';

describe('renameHostWorkspaceEntry', () => {
  it('renames regular files and preserves their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-rename-'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports', 'draft.txt'), 'unchanged contents');

    await expect(renameHostWorkspaceEntry(root, 'reports/draft.txt', 'final.txt'))
      .resolves.toEqual({ ok: true, path: 'reports/final.txt' });
    await expect(readFile(join(root, 'reports', 'final.txt'), 'utf8')).resolves.toBe('unchanged contents');
    await expect(access(join(root, 'reports', 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renames directories with their contents intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-rename-'));
    await mkdir(join(root, 'draft'));
    await writeFile(join(root, 'draft', 'result.bin'), 'payload');

    await expect(renameHostWorkspaceEntry(root, 'draft', 'published'))
      .resolves.toEqual({ ok: true, path: 'published' });
    await expect(readFile(join(root, 'published', 'result.bin'), 'utf8')).resolves.toBe('payload');
  });

  it('rejects traversal, root changes, separators, collisions, and symlinks without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-rename-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-rename-outside-'));
    await writeFile(join(root, 'source.txt'), 'source');
    await writeFile(join(root, 'existing.txt'), 'existing');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(outside, join(root, 'escape'));

    const attempts: Array<[string, string]> = [
      ['../secret.txt', 'renamed.txt'], ['.', 'renamed'], ['source.txt', '../moved.txt'],
      ['source.txt', 'nested/name.txt'], ['source.txt', 'nested\\name.txt'],
      ['source.txt', 'existing.txt'], ['link.txt', 'renamed.txt'], ['escape/secret.txt', 'renamed.txt'],
    ];
    for (const [path, name] of attempts) {
      expect((await renameHostWorkspaceEntry(root, path, name)).ok, `${path} -> ${name}`).toBe(false);
    }
    await expect(readFile(join(root, 'source.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(root, 'existing.txt'), 'utf8')).resolves.toBe('existing');
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });
});

describe('renameWorkspaceEntry', () => {
  it('forwards a confined rename to the container boundary', async () => {
    const renameContainer = vi.fn().mockResolvedValue(undefined);
    await expect(renameWorkspaceEntry({
      root: '/workspace', path: 'reports/draft.txt', newName: 'final.txt', containerId: 'container-1',
    }, renameContainer)).resolves.toEqual({ ok: true, path: 'reports/final.txt' });
    expect(renameContainer).toHaveBeenCalledWith('container-1', '/workspace', 'reports/draft.txt', 'final.txt');
  });

  it('rejects traversal and path separators before invoking the container boundary', async () => {
    const renameContainer = vi.fn();
    await expect(renameWorkspaceEntry({
      root: '/workspace', path: '../secret', newName: 'safe', containerId: 'container-1',
    }, renameContainer)).resolves.toMatchObject({ ok: false });
    await expect(renameWorkspaceEntry({
      root: '/workspace', path: 'report', newName: 'nested/report', containerId: 'container-1',
    }, renameContainer)).resolves.toMatchObject({ ok: false });
    await expect(renameWorkspaceEntry({
      root: '/workspace', path: '.', newName: 'renamed', containerId: 'container-1',
    }, renameContainer)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('root') });
    expect(renameContainer).not.toHaveBeenCalled();
  });
});
