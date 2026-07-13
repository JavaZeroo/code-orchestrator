import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { chmodHostWorkspaceFile, chmodWorkspaceFile, containerWorkspaceChmodScript } from './workspaceChmod';

const run = promisify(execFile);
const executable = async (path: string) => ((await stat(path)).mode & 0o111) !== 0;

describe('chmodHostWorkspaceFile', () => {
  it('adds and removes executable bits on a regular workspace file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-chmod-'));
    const target = join(root, 'run.sh');
    await writeFile(target, '#!/bin/sh\n');
    await chmod(target, 0o600);

    await expect(chmodHostWorkspaceFile(root, 'run.sh', true)).resolves.toEqual({ ok: true, executable: true });
    await expect(executable(target)).resolves.toBe(true);
    await expect(chmodHostWorkspaceFile(root, 'run.sh', false)).resolves.toEqual({ ok: true, executable: false });
    await expect(executable(target)).resolves.toBe(false);
  });

  it('rejects directories, symlinks, traversal, and escaped parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-chmod-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-chmod-outside-'));
    await mkdir(join(root, 'directory'));
    await writeFile(join(outside, 'secret.sh'), 'unchanged');
    await symlink(join(outside, 'secret.sh'), join(root, 'secret-link'));
    await symlink(outside, join(root, 'escape'));

    for (const path of ['directory', 'secret-link', '../secret.sh', 'escape/secret.sh']) {
      expect((await chmodHostWorkspaceFile(root, path, true)).ok, path).toBe(false);
    }
    await expect(executable(join(outside, 'secret.sh'))).resolves.toBe(false);
  });
});

describe('chmodWorkspaceFile', () => {
  it('applies the container script to regular files and rejects unsafe targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-container-workspace-chmod-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-container-workspace-chmod-outside-'));
    const target = join(root, 'run.sh');
    await writeFile(target, '#!/bin/sh\n');
    await chmod(target, 0o600);
    await mkdir(join(root, 'directory'));
    await writeFile(join(outside, 'secret.sh'), 'unchanged');
    await symlink(join(outside, 'secret.sh'), join(root, 'secret-link'));
    await symlink(outside, join(root, 'escape'));

    await expect(run('sh', ['-c', containerWorkspaceChmodScript, 'sh', root, 'run.sh', 'true']))
      .resolves.toBeDefined();
    await expect(executable(target)).resolves.toBe(true);
    await expect(run('sh', ['-c', containerWorkspaceChmodScript, 'sh', root, 'run.sh', 'false']))
      .resolves.toBeDefined();
    await expect(executable(target)).resolves.toBe(false);
    for (const path of ['directory', 'secret-link', '../secret.sh', 'escape/secret.sh']) {
      await expect(run('sh', ['-c', containerWorkspaceChmodScript, 'sh', root, path, 'true']), path)
        .rejects.toBeDefined();
    }
    await expect(executable(join(outside, 'secret.sh'))).resolves.toBe(false);
  });

  it('forwards confined container requests and rejects traversal first', async () => {
    const changeContainerMode = vi.fn().mockResolvedValue(undefined);
    await expect(chmodWorkspaceFile({
      root: '/workspace', path: 'scripts/run.sh', executable: true, containerId: 'container-1',
    }, changeContainerMode)).resolves.toEqual({ ok: true, executable: true });
    expect(changeContainerMode).toHaveBeenCalledWith('container-1', '/workspace', 'scripts/run.sh', true);

    await expect(chmodWorkspaceFile({
      root: '/workspace', path: '../run.sh', executable: true, containerId: 'container-1',
    }, changeContainerMode)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('relative') });
    expect(changeContainerMode).toHaveBeenCalledOnce();
  });
});
