import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deleteHostWorkspaceFile, deleteWorkspaceFile } from './workspaceDelete';

describe('deleteHostWorkspaceFile', () => {
  it('deletes a regular file beneath the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'result.bin'), 'bytes');

    await expect(deleteHostWorkspaceFile(root, 'out/result.bin')).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'out', 'result.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects directories, symlinks, traversal, escaped parents, and the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-delete-outside-'));
    await mkdir(join(root, 'directory'));
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));
    await symlink(outside, join(root, 'escape'));

    for (const path of ['directory', 'secret-link', '../outside.txt', 'escape/secret.txt', '.']) {
      expect((await deleteHostWorkspaceFile(root, path)).ok, path).toBe(false);
    }
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });
});

describe('deleteWorkspaceFile', () => {
  it('forwards a confined relative path to the container deleter', async () => {
    const deleter = vi.fn().mockResolvedValue(undefined);
    await expect(deleteWorkspaceFile({
      root: '/workspace', path: 'out/model.bin', containerId: 'container-1',
    }, deleter)).resolves.toEqual({ ok: true });
    expect(deleter).toHaveBeenCalledWith('container-1', '/workspace', 'out/model.bin');
  });

  it('rejects traversal before invoking the container deleter', async () => {
    const deleter = vi.fn();
    await expect(deleteWorkspaceFile({
      root: '/workspace', path: '../secret', containerId: 'container-1',
    }, deleter)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('relative') });
    expect(deleter).not.toHaveBeenCalled();
  });
});
