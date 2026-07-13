import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { containerWorkspaceDeleteScript, deleteHostWorkspaceFile, deleteWorkspaceFile } from './workspaceDelete';

const run = promisify(execFile);

describe('deleteHostWorkspaceFile', () => {
  it('deletes a regular file beneath the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'result.bin'), 'bytes');

    await expect(deleteHostWorkspaceFile(root, 'out/result.bin')).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'out', 'result.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes an empty directory beneath the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    await mkdir(join(root, 'empty'));

    await expect(deleteHostWorkspaceFile(root, 'empty')).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recursively deletes non-empty directories without following contained symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-delete-outside-'));
    await mkdir(join(root, 'reports', 'nested'), { recursive: true });
    await writeFile(join(root, 'reports', 'nested', 'result.txt'), 'delete me');
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(outside, join(root, 'reports', 'outside-link'));

    await expect(deleteHostWorkspaceFile(root, 'reports')).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'reports'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects symlinks, traversal, escaped parents, and the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-delete-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));
    await symlink(outside, join(root, 'escape'));

    for (const path of ['secret-link', '../outside.txt', 'escape/secret.txt', '.']) {
      expect((await deleteHostWorkspaceFile(root, path)).ok, path).toBe(false);
    }
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });
});

describe('deleteWorkspaceFile', () => {
  it('recursively deletes container directories without following contained symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-container-workspace-delete-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-container-workspace-delete-outside-'));
    await mkdir(join(root, 'empty'));
    await mkdir(join(root, 'non-empty', 'nested'), { recursive: true });
    await writeFile(join(root, 'non-empty', 'nested', 'result.txt'), 'delete me');
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(outside, join(root, 'non-empty', 'outside-link'));

    await expect(run('sh', ['-c', containerWorkspaceDeleteScript, 'sh', root, 'empty'])).resolves.toBeDefined();
    await expect(access(join(root, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(run('sh', ['-c', containerWorkspaceDeleteScript, 'sh', root, 'non-empty'])).resolves.toBeDefined();
    await expect(access(join(root, 'non-empty'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });

  it('keeps container workspace roots, traversal targets, and escaped symlinks intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-container-workspace-delete-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-container-workspace-delete-outside-'));
    await writeFile(join(root, 'keep.txt'), 'unchanged');
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(outside, join(root, 'escape'));

    for (const path of ['.', '../outside', 'escape', 'escape/secret.txt']) {
      await expect(run('sh', ['-c', containerWorkspaceDeleteScript, 'sh', root, path]), path).rejects.toBeDefined();
    }
    await expect(readFile(join(root, 'keep.txt'), 'utf8')).resolves.toBe('unchanged');
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });

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
