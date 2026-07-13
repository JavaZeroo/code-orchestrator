import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { archiveHostWorkspaceDirectory, WORKSPACE_ARCHIVE_MAX_BYTES, WORKSPACE_ARCHIVE_MAX_ENTRIES } from './workspaceArchive';
import { extractHostWorkspaceArchive, extractWorkspaceArchive } from './workspaceExtract';

type TestEntry = { path: string; type?: string; data?: Buffer };

function tar(entries: TestEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const data = entry.data ?? Buffer.alloc(0);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, data);
    const padding = (512 - data.length % 512) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(chunks));
}

describe('extractHostWorkspaceArchive', () => {
  it('recreates regular files and directories beside the selected archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
    await mkdir(join(root, 'uploads', 'source', 'nested'), { recursive: true });
    await writeFile(join(root, 'uploads', 'source', 'summary.txt'), 'ready');
    await writeFile(join(root, 'uploads', 'source', 'nested', 'result.bin'), Buffer.from([0, 255, 7]));
    const archive = await archiveHostWorkspaceDirectory(root, 'uploads/source');
    await writeFile(join(root, 'uploads', 'source.tar.gz'), Buffer.from(archive.data!, 'base64'));
    await import('node:fs/promises').then(({ rm }) => rm(join(root, 'uploads', 'source'), { recursive: true }));

    await expect(extractHostWorkspaceArchive(root, 'uploads/source.tar.gz'))
      .resolves.toEqual({ ok: true, entries: 4 });
    await expect(readFile(join(root, 'uploads', 'source', 'summary.txt'), 'utf8')).resolves.toBe('ready');
    await expect(readFile(join(root, 'uploads', 'source', 'nested', 'result.bin'))).resolves.toEqual(Buffer.from([0, 255, 7]));
  });

  it.each([
    ['absolute paths', [{ path: '/escape.txt', data: Buffer.from('bad') }]],
    ['traversal paths', [{ path: '../escape.txt', data: Buffer.from('bad') }]],
    ['links', [{ path: 'linked', type: '2' }]],
    ['special files', [{ path: 'pipe', type: '6' }]],
  ])('rejects %s without writing partial output', async (_label, entries) => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
    await writeFile(join(root, 'unsafe.tar.gz'), tar(entries));
    const result = await extractHostWorkspaceArchive(root, 'unsafe.tar.gz');
    expect(result.ok).toBe(false);
    await expect(access(join(root, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, 'linked'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, 'pipe'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects destination conflicts without leaving any other archive entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
    await writeFile(join(root, 'bundle.tar.gz'), tar([
      { path: 'new.txt', data: Buffer.from('new') },
      { path: 'taken.txt', data: Buffer.from('replace') },
    ]));
    await writeFile(join(root, 'taken.txt'), 'keep');

    await expect(extractHostWorkspaceArchive(root, 'bundle.tar.gz'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('destination already exists') });
    await expect(readFile(join(root, 'taken.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats dangling destination symlinks as conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
    await writeFile(join(root, 'bundle.tar.gz'), tar([{ path: 'dangling', data: Buffer.from('replace') }]));
    await symlink('missing-target', join(root, 'dangling'));

    await expect(extractHostWorkspaceArchive(root, 'bundle.tar.gz'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('destination already exists') });
  });

  it('rejects archives beyond the entry and decompressed-content bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-extract-'));
    await writeFile(join(root, 'entries.tar.gz'), tar(Array.from(
      { length: WORKSPACE_ARCHIVE_MAX_ENTRIES + 1 },
      (_, index) => ({ path: `entry-${index}` }),
    )));
    await writeFile(join(root, 'large.tar.gz'), tar([
      { path: 'large.bin', data: Buffer.alloc(WORKSPACE_ARCHIVE_MAX_BYTES + 1) },
    ]));

    await expect(extractHostWorkspaceArchive(root, 'entries.tar.gz'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('entry limit') });
    await expect(extractHostWorkspaceArchive(root, 'large.tar.gz'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('byte limit') });
  });

  it('routes container extraction through the isolated container adapter', async () => {
    const containerRoot = await mkdtemp(join(tmpdir(), 'co-container-workspace-extract-'));
    await writeFile(join(containerRoot, 'bundle.tar.gz'), tar([
      { path: 'bundle', type: '5' },
      { path: 'bundle/result.txt', data: Buffer.from('from container') },
    ]));
    const adapter = vi.fn(async () => {
      const result = await extractHostWorkspaceArchive(containerRoot, 'bundle.tar.gz');
      if (!result.ok || result.entries === undefined) throw new Error(result.error);
      return result.entries;
    });
    await expect(extractWorkspaceArchive({
      root: '/workspace', path: 'uploads/bundle.tar.gz', containerId: 'container-1',
    }, adapter)).resolves.toEqual({ ok: true, entries: 2 });
    expect(adapter).toHaveBeenCalledWith({
      root: '/workspace', path: 'uploads/bundle.tar.gz', containerId: 'container-1',
    });
    await expect(readFile(join(containerRoot, 'bundle', 'result.txt'), 'utf8')).resolves.toBe('from container');
  });
});
