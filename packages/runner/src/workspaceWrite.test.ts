import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_FILE_MAX_BYTES } from './workspaceFile';
import { writeHostWorkspaceFile, writeWorkspaceFile } from './workspaceWrite';

describe('writeHostWorkspaceFile', () => {
  it('preserves exact bytes beneath an existing workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-write-'));
    await mkdir(join(root, 'out'));
    const bytes = Buffer.from([0, 17, 128, 255, 10]);

    await expect(writeHostWorkspaceFile(root, 'out/result.bin', bytes)).resolves.toEqual({ ok: true, size: 5 });
    await expect(readFile(join(root, 'out', 'result.bin'))).resolves.toEqual(bytes);
  });

  it('rejects traversal, escaped parent symlinks, destination symlinks, and oversized payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-write-'));
    const outside = await mkdtemp(join(tmpdir(), 'co-workspace-write-outside-'));
    await symlink(outside, join(root, 'escape'));
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));

    for (const [path, data] of [
      ['../outside.bin', Buffer.from('x')],
      ['escape/new.bin', Buffer.from('x')],
      ['secret-link', Buffer.from('changed')],
      ['large.bin', Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1)],
    ] as const) {
      expect((await writeHostWorkspaceFile(root, path, data)).ok, path).toBe(false);
    }
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
  });
});

describe('writeWorkspaceFile', () => {
  it('passes exact decoded bytes and destination to the container writer', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const writer = vi.fn().mockResolvedValue(undefined);
    await expect(writeWorkspaceFile({
      root: '/workspace', path: 'out/model.bin', containerId: 'container-1',
      data: bytes.toString('base64'), size: bytes.length,
    }, writer)).resolves.toEqual({ ok: true, size: bytes.length });
    expect(writer).toHaveBeenCalledWith('container-1', '/workspace', 'out/model.bin', bytes);
  });

  it('rejects malformed and oversized encoded payloads before writing', async () => {
    const writer = vi.fn();
    await expect(writeWorkspaceFile({
      root: '/workspace', path: 'out/model.bin', containerId: 'container-1', data: 'AA==', size: 2,
    }, writer)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('size') });
    expect(writer).not.toHaveBeenCalled();
  });
});
