import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { restoreWorkspaceFile } from './workspaceRestore';

const run = promisify(execFile);

async function createCommittedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'co-restore-'));
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'selected.txt'), 'selected before\n');
  await writeFile(join(root, 'other.txt'), 'other before\n');
  await run('git', ['add', '.'], { cwd: root });
  await run('git', [
    '-c', 'user.name=Restore Test', '-c', 'user.email=restore@example.com', 'commit', '-qm', 'base',
  ], { cwd: root });
  return root;
}

describe('restoreWorkspaceFile', () => {
  it('restores only the selected tracked file from HEAD, including staged changes', async () => {
    const root = await createCommittedRepo();
    await writeFile(join(root, 'selected.txt'), 'selected staged\n');
    await run('git', ['add', 'selected.txt'], { cwd: root });
    await writeFile(join(root, 'selected.txt'), 'selected working tree\n');
    await writeFile(join(root, 'other.txt'), 'other changed\n');

    await expect(restoreWorkspaceFile({ root, path: 'selected.txt' })).resolves.toEqual({ ok: true });

    await expect(readFile(join(root, 'selected.txt'), 'utf8')).resolves.toBe('selected before\n');
    await expect(readFile(join(root, 'other.txt'), 'utf8')).resolves.toBe('other changed\n');
    const { stdout } = await run('git', ['status', '--short'], { cwd: root });
    expect(stdout).toBe(' M other.txt\n');
  });

  it('restores a deleted tracked file without touching another deletion', async () => {
    const root = await createCommittedRepo();
    await rm(join(root, 'selected.txt'));
    await rm(join(root, 'other.txt'));

    await expect(restoreWorkspaceFile({ root, path: 'selected.txt' })).resolves.toEqual({ ok: true });

    await expect(readFile(join(root, 'selected.txt'), 'utf8')).resolves.toBe('selected before\n');
    await expect(readFile(join(root, 'other.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats Git pathspec syntax as a literal single filename', async () => {
    const root = await createCommittedRepo();
    const magicPath = ':(glob)*';
    await writeFile(join(root, magicPath), 'magic before\n');
    await run('git', ['--literal-pathspecs', 'add', '--', magicPath], { cwd: root });
    await run('git', [
      '-c', 'user.name=Restore Test', '-c', 'user.email=restore@example.com', 'commit', '-qm', 'magic path',
    ], { cwd: root });
    await writeFile(join(root, magicPath), 'magic changed\n');
    await writeFile(join(root, 'other.txt'), 'other changed\n');

    await expect(restoreWorkspaceFile({ root, path: magicPath })).resolves.toEqual({ ok: true });
    await expect(readFile(join(root, magicPath), 'utf8')).resolves.toBe('magic before\n');
    await expect(readFile(join(root, 'other.txt'), 'utf8')).resolves.toBe('other changed\n');
  });

  it('rejects untracked, outside, and non-Git paths without mutation', async () => {
    const root = await createCommittedRepo();
    await writeFile(join(root, 'untracked.txt'), 'keep me\n');
    const outside = join(root, '..', 'outside.txt');
    await writeFile(outside, 'outside\n');

    await expect(restoreWorkspaceFile({ root, path: 'untracked.txt' })).resolves.toMatchObject({
      ok: false, error: 'path is not a tracked file in Git HEAD',
    });
    await expect(restoreWorkspaceFile({ root, path: '../outside.txt' })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('cannot traverse'),
    });
    await expect(readFile(join(root, 'untracked.txt'), 'utf8')).resolves.toBe('keep me\n');
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside\n');

    const nonGit = await mkdtemp(join(tmpdir(), 'co-restore-non-git-'));
    await writeFile(join(nonGit, 'file.txt'), 'unchanged\n');
    await expect(restoreWorkspaceFile({ root: nonGit, path: 'file.txt' })).resolves.toMatchObject({
      ok: false, error: 'not a git repository',
    });
    await expect(readFile(join(nonGit, 'file.txt'), 'utf8')).resolves.toBe('unchanged\n');
  });

  it('forwards container restores to the scoped executor', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await expect(restoreWorkspaceFile({
      root: '/workspace', path: 'src/main.ts', containerId: 'container-1',
    }, execute)).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith('/workspace', 'src/main.ts', 'container-1');
  });
});
