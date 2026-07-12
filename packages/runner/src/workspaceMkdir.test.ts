import { access, mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHostWorkspaceDirectory, createWorkspaceDirectory } from './workspaceMkdir';

describe('createHostWorkspaceDirectory', () => {
  it('creates one new directory beneath an existing workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-mkdir-'));
    await mkdir(join(root, 'reports'));

    await expect(createHostWorkspaceDirectory(root, 'reports/daily')).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'reports', 'daily'))).resolves.toBeUndefined();
  });

  it('rejects absolute paths, traversal, symlink escapes, and existing destinations without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-mkdir-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-mkdir-outside-'));
    await mkdir(join(root, 'existing'));
    await symlink(outside, join(root, 'escape'));

    for (const path of ['/tmp/absolute', '../outside', 'escape/new', 'existing']) {
      expect((await createHostWorkspaceDirectory(root, path)).ok, path).toBe(false);
    }
    await expect(access(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createWorkspaceDirectory', () => {
  it('forwards a confined relative path to the container mkdir boundary', async () => {
    const mkdirContainer = vi.fn().mockResolvedValue(undefined);
    await expect(createWorkspaceDirectory({
      root: '/workspace', path: 'reports/daily', containerId: 'container-1',
    }, mkdirContainer)).resolves.toEqual({ ok: true });
    expect(mkdirContainer).toHaveBeenCalledWith('container-1', '/workspace', 'reports/daily');
  });

  it('rejects traversal before invoking the container mkdir boundary', async () => {
    const mkdirContainer = vi.fn();
    await expect(createWorkspaceDirectory({
      root: '/workspace', path: '../secret', containerId: 'container-1',
    }, mkdirContainer)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('relative') });
    expect(mkdirContainer).not.toHaveBeenCalled();
  });
});
