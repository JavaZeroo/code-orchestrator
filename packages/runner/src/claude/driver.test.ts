import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalRequest } from '@co/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSession, forkClaudeNativeSession, type DriverEmit } from './driver';

const queryMock = vi.hoisted(() => vi.fn());
const forkSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: queryMock, forkSession: forkSessionMock };
});

function fakeQuery(nativeSessionId: string): Query {
  const stream = {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: nativeSessionId };
    },
  };
  return stream as unknown as Query;
}

describe('forkClaudeNativeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the SDK fork API to copy the complete saved transcript', async () => {
    forkSessionMock.mockResolvedValue({ sessionId: 'claude-native-fork' });

    await expect(forkClaudeNativeSession('claude-native-source', '/tmp/work')).resolves.toBe(
      'claude-native-fork',
    );
    expect(forkSessionMock).toHaveBeenCalledWith('claude-native-source', { dir: '/tmp/work' });
  });

  it('rejects a fork that does not receive a distinct native session ID', async () => {
    forkSessionMock.mockResolvedValue({ sessionId: 'claude-native-source' });

    await expect(forkClaudeNativeSession('claude-native-source', '/tmp/work')).rejects.toThrow(
      'distinct forked session',
    );
  });
});

describe('ClaudeSession resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReturnValue(fakeQuery('claude-native-1'));
  });

  it('passes the persisted native session ID to the SDK resume option', async () => {
    const emit: DriverEmit = {
      event: vi.fn(),
      state: vi.fn(),
      approval: vi.fn<(request: ApprovalRequest) => void>(),
      draft: vi.fn(async () => ({ ok: true })),
      taskPlan: vi.fn(async () => ({ ok: true })),
    };
    const session = new ClaudeSession(
      { sessionId: 'session-1', agent: 'claude', cwd: '/tmp/work' },
      emit,
      'claude-native-1',
    );

    session.start();
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    const call = queryMock.mock.calls[0]![0] as { options: Options };
    expect(call.options).toMatchObject({ cwd: '/tmp/work', resume: 'claude-native-1' });
    await vi.waitFor(() =>
      expect(emit.state).toHaveBeenCalledWith('thinking', 'claude-native-1', undefined),
    );
  });
});
