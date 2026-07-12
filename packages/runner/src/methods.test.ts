import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunnerMethodHandler } from './methods';

function handler() {
  return createRunnerMethodHandler({ conn: null });
}

describe('createRunnerMethodHandler', () => {
  it('executes machine.exec and returns stdout plus exit code', async () => {
    const result = await handler()('machine.exec', {
      cmd: 'node -e "process.stdout.write(\'runner-ok\')"',
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'runner-ok', stderr: '' });
  });

  it('maps non-zero machine.exec failures without throwing', async () => {
    const result = await handler()('machine.exec', {
      cmd: 'node -e "process.stderr.write(\'bad\'); process.exit(7)"',
    });

    expect(result).toEqual({ exitCode: 7, stdout: '', stderr: 'bad' });
  });

  it('dispatches workspace.read through the bounded file reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-method-file-'));
    await writeFile(join(root, 'answer.txt'), 'runner bytes');
    const result = await handler()('workspace.read', { root, path: 'answer.txt' });
    expect(result).toEqual({
      ok: true,
      basename: 'answer.txt',
      size: 12,
      data: Buffer.from('runner bytes').toString('base64'),
    });
  });

  it('dispatches workspace.write through the confined binary writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-method-write-'));
    const bytes = Buffer.from([0, 128, 255]);
    const result = await handler()('workspace.write', {
      root, path: 'answer.bin', data: bytes.toString('base64'), size: bytes.length,
    });
    expect(result).toEqual({ ok: true, size: bytes.length });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'answer.bin')))).resolves.toEqual(bytes);
  });

  it('dispatches workspace.list through the confined directory reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-method-list-'));
    await writeFile(join(root, 'answer.txt'), 'runner bytes');
    const result = await handler()('workspace.list', { root });
    expect(result).toEqual({
      ok: true, path: '', entries: [{ name: 'answer.txt', type: 'file', size: 12 }], truncated: false,
    });
  });

  it('dispatches workspace.delete through the confined file deleter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-method-delete-'));
    await writeFile(join(root, 'answer.txt'), 'runner bytes');
    await expect(handler()('workspace.delete', { root, path: 'answer.txt' })).resolves.toEqual({ ok: true });
    await expect(access(join(root, 'answer.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported opencode session spawn without creating a session', async () => {
    const result = await handler()('session.spawn', {
      sessionId: 's-opencode',
      agent: 'opencode',
      cwd: '/tmp',
    });

    expect(result).toEqual({ ok: false, error: 'agent "opencode" not supported yet' });
  });

  it('reports missing sessions for send, interrupt, and approval decisions', async () => {
    await expect(handler()('session.send', { sessionId: 'missing', text: 'hello' })).resolves.toEqual({
      ok: false,
      error: 'session not running: missing',
    });
    await expect(handler()('session.interrupt', { sessionId: 'missing' })).resolves.toEqual({
      ok: false,
      error: 'session not running: missing',
    });
    await expect(
      handler()('approval.decide', {
        sessionId: 'missing',
        approvalId: 'a1',
        decision: { behavior: 'allow' },
      }),
    ).resolves.toEqual({ ok: false, error: 'session not found: missing' });
  });

  it('throws for unknown methods and invalid params', async () => {
    await expect(handler()('nope', {})).rejects.toThrow('unknown method: nope');
    await expect(handler()('machine.exec', { timeoutMs: 10 })).rejects.toThrow();
  });
});
