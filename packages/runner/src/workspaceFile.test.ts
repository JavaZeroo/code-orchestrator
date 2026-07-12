import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHostWorkspaceFile, readWorkspaceFile, WORKSPACE_FILE_MAX_BYTES } from './workspaceFile';

describe('readHostWorkspaceFile', () => {
  it('reads a regular file as bounded base64 data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-file-'));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'result.bin'), Buffer.from([0, 1, 2, 255]));

    await expect(readHostWorkspaceFile(root, 'out/result.bin')).resolves.toEqual({
      ok: true,
      basename: 'result.bin',
      size: 4,
      data: Buffer.from([0, 1, 2, 255]).toString('base64'),
    });
  });

  it('rejects absolute paths, traversal, directories, and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-file-'));
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'large.bin'), Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1));

    for (const path of ['/etc/passwd', '../secret', 'dir', 'large.bin']) {
      const result = await readHostWorkspaceFile(root, path);
      expect(result.ok, path).toBe(false);
    }
  });

  it('rejects symlinks that resolve outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-file-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-secret-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));

    const result = await readHostWorkspaceFile(root, 'escape.txt');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('symlink escapes') });
  });

  it('copies a container file to an isolated directory before applying the same checks', async () => {
    const copy = async (containerId: string, source: string, target: string) => {
      expect(containerId).toBe('container-1');
      expect(source).toBe('/workspace/out/model.bin');
      await writeFile(target, Buffer.from([7, 8, 9]));
    };
    await expect(readWorkspaceFile({
      root: '/workspace', path: 'out/model.bin', containerId: 'container-1',
    }, copy)).resolves.toEqual({
      ok: true, basename: 'model.bin', size: 3, data: Buffer.from([7, 8, 9]).toString('base64'),
    });
  });
});
