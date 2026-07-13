import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  archiveHostWorkspaceDirectory,
  archiveWorkspaceDirectory,
  WORKSPACE_ARCHIVE_MAX_BYTES,
} from './workspaceArchive';

function readTar(data: string): Map<string, Buffer> {
  const tar = gunzipSync(Buffer.from(data, 'base64'));
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    offset += 512;
    entries.set(name, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('archiveHostWorkspaceDirectory', () => {
  it('creates a gzip tar archive that preserves the selected relative tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-archive-'));
    await mkdir(join(root, 'reports', 'nested'), { recursive: true });
    await writeFile(join(root, 'reports', 'summary.txt'), 'ready');
    await writeFile(join(root, 'reports', 'nested', 'result.bin'), Buffer.from([0, 255, 7]));

    const result = await archiveHostWorkspaceDirectory(root, 'reports');

    expect(result).toMatchObject({ ok: true, basename: 'reports.tar.gz' });
    const entries = readTar(result.data!);
    expect([...entries.keys()]).toEqual([
      'reports',
      'reports/nested',
      'reports/nested/result.bin',
      'reports/summary.txt',
    ]);
    expect(entries.get('reports/nested/result.bin')).toEqual(Buffer.from([0, 255, 7]));
    expect(entries.get('reports/summary.txt')?.toString()).toBe('ready');
    expect(Buffer.from(result.data!, 'base64')).toHaveLength(result.size!);
  });

  it('rejects traversal, workspace-root selection, files, symlinks, and oversized trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-archive-'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'result.txt'), 'ready');
    await writeFile(join(root, 'reports', 'large.bin'), Buffer.alloc(WORKSPACE_ARCHIVE_MAX_BYTES + 1));
    await symlink(join(root, 'reports'), join(root, 'linked-reports'));
    await mkdir(join(root, 'unsafe'));
    await symlink(join(root, 'result.txt'), join(root, 'unsafe', 'linked-result.txt'));

    for (const path of ['../reports', '.', 'result.txt', 'linked-reports', 'unsafe', 'reports']) {
      const result = await archiveHostWorkspaceDirectory(root, path);
      expect(result.ok, path).toBe(false);
    }
  });

  it('copies a validated container directory before applying host archive bounds', async () => {
    const copy = async (containerId: string, root: string, path: string, target: string) => {
      expect({ containerId, root, path }).toEqual({
        containerId: 'container-1', root: '/workspace', path: 'out/reports',
      });
      await mkdir(join(target, 'nested'), { recursive: true });
      await writeFile(join(target, 'nested', 'answer.txt'), 'container ready');
    };

    const result = await archiveWorkspaceDirectory({
      root: '/workspace', path: 'out/reports', containerId: 'container-1',
    }, copy);

    expect(result).toMatchObject({ ok: true, basename: 'reports.tar.gz' });
    expect(readTar(result.data!).get('reports/nested/answer.txt')?.toString()).toBe('container ready');
  });

  it('rejects container traversal before copying and symlinks in copied trees', async () => {
    let copied = false;
    const copy = async (_containerId: string, _root: string, _path: string, target: string) => {
      copied = true;
      await mkdir(target);
      await symlink('/etc/passwd', join(target, 'escape.txt'));
    };

    await expect(archiveWorkspaceDirectory({
      root: '/workspace', path: '../secret', containerId: 'container-1',
    }, copy)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('traverse') });
    expect(copied).toBe(false);

    await expect(archiveWorkspaceDirectory({
      root: '/workspace', path: 'reports', containerId: 'container-1',
    }, copy)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('symlinks') });
  });
});
