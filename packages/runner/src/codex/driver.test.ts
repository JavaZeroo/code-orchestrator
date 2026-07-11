import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ApprovalRequest } from '@co/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverEmit } from '../claude/driver';
import { CodexSession } from './driver';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

function createFixture(resumeNativeSessionId?: string) {
  const child = new FakeCodexProcess();
  const outbound: RpcMessage[] = [];
  let buffered = '';

  child.stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      outbound.push(message);
      if (message.method === 'initialize') {
        setImmediate(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
      } else if (message.method === 'thread/start') {
        setImmediate(() =>
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } })}\n`),
        );
      } else if (message.method === 'thread/resume') {
        const threadId = (message.params as { threadId?: string } | undefined)?.threadId ?? 'thread-1';
        setImmediate(() =>
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId } } })}\n`),
        );
      }
    }
  });

  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const approval = vi.fn<(request: ApprovalRequest) => void>();
  const emit: DriverEmit = {
    event: vi.fn(),
    state: vi.fn(),
    approval,
    draft: vi.fn(async () => ({ ok: true })),
    taskPlan: vi.fn(async () => ({ ok: true })),
  };
  const session = new CodexSession(
    { sessionId: 'session-1', agent: 'codex', cwd: '/tmp/work' },
    emit,
    resumeNativeSessionId,
  );

  return {
    approval,
    child,
    outbound,
    session,
    sendFromCodex: (message: RpcMessage) => child.stdout.write(`${JSON.stringify(message)}\n`),
  };
}

describe('CodexSession resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses thread/resume with the persisted native thread ID', async () => {
    const fixture = createFixture('thread-existing');
    fixture.session.start();

    await vi.waitFor(() => expect(fixture.session.state).toBe('idle'));
    expect(fixture.outbound).toContainEqual(
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId: 'thread-existing', cwd: '/tmp/work' }),
      }),
    );
    expect(fixture.outbound).not.toContainEqual(expect.objectContaining({ method: 'thread/start' }));
    expect(fixture.session.nativeSessionId).toBe('thread-existing');
  });
});

describe('CodexSession interactive questions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for the user and returns their answers to the matching app-server request', async () => {
    const fixture = createFixture();
    fixture.session.start();
    await vi.waitFor(() => expect(fixture.session.state).toBe('idle'));

    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which area should be changed?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'Runner', description: 'Only update the runner package.' }],
        },
      ],
      autoResolutionMs: null,
    };
    fixture.sendFromCodex({
      id: 'question-request-1',
      method: 'item/tool/requestUserInput',
      params,
    });

    await vi.waitFor(() => expect(fixture.approval).toHaveBeenCalledTimes(1));
    const request = fixture.approval.mock.calls[0]![0];
    expect(request).toMatchObject({
      kind: 'tool',
      sessionId: 'session-1',
      payload: { backend: 'codex', method: 'item/tool/requestUserInput', params },
    });
    expect(fixture.session.state).toBe('waiting_input');
    expect(fixture.outbound).not.toContainEqual(expect.objectContaining({ id: 'question-request-1' }));

    const answers = { scope: { answers: ['Runner'] } };
    expect(
      fixture.session.decideApproval(request.id, {
        behavior: 'allow',
        updatedInput: { answers },
      }),
    ).toBe(true);

    expect(fixture.outbound).toContainEqual({ id: 'question-request-1', result: { answers } });
    expect(fixture.session.state).toBe('thinking');
  });

  it('dismisses a question with an empty answer map', async () => {
    const fixture = createFixture();
    fixture.session.start();
    await vi.waitFor(() => expect(fixture.session.state).toBe('idle'));

    fixture.sendFromCodex({
      id: 'question-request-2',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        questions: [{ id: 'detail', header: 'Detail', question: 'Anything else?', isOther: false, isSecret: false, options: null }],
        autoResolutionMs: null,
      },
    });

    await vi.waitFor(() => expect(fixture.approval).toHaveBeenCalledTimes(1));
    const request = fixture.approval.mock.calls[0]![0];
    expect(fixture.session.decideApproval(request.id, { behavior: 'deny', message: 'dismissed' })).toBe(true);
    expect(fixture.outbound).toContainEqual({ id: 'question-request-2', result: { answers: {} } });
  });

  it.each([
    ['item/commandExecution/requestApproval', { command: 'pnpm test' }],
    ['item/fileChange/requestApproval', { changes: [{ path: 'src/index.ts' }] }],
  ])('keeps %s approval responses unchanged', async (method, params) => {
    const fixture = createFixture();
    fixture.session.start();
    await vi.waitFor(() => expect(fixture.session.state).toBe('idle'));

    fixture.sendFromCodex({ id: 'tool-request-1', method, params });
    await vi.waitFor(() => expect(fixture.approval).toHaveBeenCalledTimes(1));
    const request = fixture.approval.mock.calls[0]![0];
    expect(fixture.session.state).toBe('waiting_approval');

    expect(fixture.session.decideApproval(request.id, { behavior: 'allow' })).toBe(true);
    expect(fixture.outbound).toContainEqual({ id: 'tool-request-1', result: { decision: 'accept' } });
  });
});
