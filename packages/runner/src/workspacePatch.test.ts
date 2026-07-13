import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { generateWorkspacePatch, WORKSPACE_PATCH_MAX_BYTES } from './workspacePatch';

const run = promisify(execFile);

async function createCommittedRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'before\n');
  await writeFile(join(root, 'image.bin'), Buffer.alloc(2_048, 0));
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['-c', 'user.name=Patch Test', '-c', 'user.email=patch@example.com', 'commit', '-qm', 'base'], { cwd: root });
  return root;
}

describe('generateWorkspacePatch', () => {
  it('creates complete binary patches accepted by git apply', async () => {
    const source = await createCommittedRepo('co-patch-source-');
    const target = await mkdtemp(join(tmpdir(), 'co-patch-target-'));
    await run('git', ['clone', '-q', source, target]);
    await writeFile(join(source, 'tracked.txt'), 'after\n');
    await writeFile(join(source, 'image.bin'), Buffer.alloc(2_048, 255));

    const result = await generateWorkspacePatch({ root: source });

    expect(result.ok).toBe(true);
    const patch = Buffer.from(result.data!, 'base64');
    expect(patch).toHaveLength(result.size!);
    expect(patch.toString('utf8')).toContain('GIT binary patch');
    const patchPath = join(target, 'session.patch');
    await writeFile(patchPath, patch);
    await expect(run('git', ['apply', '--check', patchPath], { cwd: target })).resolves.toBeDefined();
  });

  it('returns an empty successful payload when tracked files are unchanged', async () => {
    const root = await createCommittedRepo('co-patch-empty-');
    await expect(generateWorkspacePatch({ root })).resolves.toEqual({ ok: true, size: 0, data: '' });
  });

  it('reports non-git workspaces without producing an attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-patch-non-git-'));
    const result = await generateWorkspacePatch({ root });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a git repository');
  });

  it('rejects generated patches above the transfer bound', async () => {
    const execute = vi.fn().mockResolvedValue(Buffer.alloc(WORKSPACE_PATCH_MAX_BYTES + 1));
    await expect(generateWorkspacePatch({ root: '/work' }, execute)).resolves.toEqual({
      ok: false,
      error: `patch exceeds the ${WORKSPACE_PATCH_MAX_BYTES}-byte limit`,
    });
  });

  it('forwards the session container to the scoped executor', async () => {
    const execute = vi.fn().mockResolvedValue(Buffer.from('patch bytes'));
    await generateWorkspacePatch({ root: '/workspace', containerId: 'container-1' }, execute);
    expect(execute).toHaveBeenCalledWith('/workspace', 'container-1');
  });
});
