import { describe, expect, it, vi } from 'vitest';
import type { EventRow, SessionEnvelope, SessionEventPage, SessionRow } from '../api';
import {
  collectSessionTranscriptEvents,
  exportSessionTranscript,
  formatSessionTranscript,
  sessionTranscriptFilename,
  type FetchSessionEventPage,
} from './transcript';

const session: SessionRow = {
  id: 'session-12345678',
  machineId: 'runner-1',
  agent: 'codex',
  model: 'gpt-5',
  cwd: '/work/release',
  title: 'Release audit',
  state: 'thinking',
  nativeSessionId: 'thread-1',
  runId: null,
  nodeId: null,
  projectId: null,
  containerId: null,
  usage: null,
  archivedAt: null,
  createdAt: '2026-07-12T00:00:00.000Z',
};

function event(seq: number, payload: unknown = { marker: seq }): EventRow {
  return { seq, type: 'session.message', payload };
}

function page(events: EventRow[], hasEarlier: boolean, before: number | null): SessionEventPage {
  return { events, page: { hasEarlier, before } };
}

function message(
  seq: number,
  role: SessionEnvelope['role'],
  ev: SessionEnvelope['ev'],
): EventRow {
  return {
    seq,
    type: 'session.message',
    payload: {
      id: `message-${seq}`,
      time: Date.parse(`2026-07-12T00:00:${String(seq).padStart(2, '0')}.000Z`),
      role,
      ev,
    } satisfies SessionEnvelope,
  };
}

describe('session transcript event collection', () => {
  it('walks every backward page, deduplicates overlaps, and returns chronological events', async () => {
    const fetchPage = vi.fn<FetchSessionEventPage>(async (_sessionId, cursor) => {
      if (!cursor) return page([event(4, { source: 'newest' }), event(5)], true, 4);
      if (cursor.before === 4) return page([event(2), event(3), event(4, { source: 'overlap' })], true, 2);
      return page([event(1), event(2)], false, null);
    });

    const events = await collectSessionTranscriptEvents(session.id, fetchPage);

    expect(fetchPage).toHaveBeenNthCalledWith(1, session.id, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, session.id, { before: 4 });
    expect(fetchPage).toHaveBeenNthCalledWith(3, session.id, { before: 2 });
    expect(events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.find((row) => row.seq === 4)?.payload).toEqual({ source: 'newest' });
  });

  it('does not download a partial transcript when an earlier page fails', async () => {
    const fetchPage = vi.fn<FetchSessionEventPage>()
      .mockResolvedValueOnce(page([event(3), event(4)], true, 3))
      .mockRejectedValueOnce(new Error('history unavailable'));
    const download = vi.fn();

    await expect(exportSessionTranscript(session, fetchPage, download)).rejects.toThrow('history unavailable');
    expect(fetchPage).toHaveBeenNthCalledWith(2, session.id, { before: 3 });
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads the formatted snapshot only after the oldest page succeeds', async () => {
    let reachedOldestPage = false;
    const fetchPage = vi.fn<FetchSessionEventPage>(async (_sessionId, cursor) => {
      if (!cursor) return page([message(2, 'agent', { t: 'text', text: 'Latest answer' })], true, 2);
      reachedOldestPage = true;
      return page([message(1, 'user', { t: 'text', text: 'Earliest question' })], false, null);
    });
    const download = vi.fn(() => {
      expect(reachedOldestPage).toBe(true);
    });

    const transcript = await exportSessionTranscript(session, fetchPage, download);

    expect(transcript.events.map((row) => row.seq)).toEqual([1, 2]);
    expect(transcript.markdown.indexOf('Earliest question')).toBeLessThan(transcript.markdown.indexOf('Latest answer'));
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith('Release-audit-session-12345678.md', transcript.markdown);
  });
});

describe('session transcript Markdown', () => {
  it('omits deleted note content but retains its audit tombstone', () => {
    const markdown = formatSessionTranscript(session, [
      { seq: 9, type: 'session.note', payload: { markdown: 'Obsolete handoff.', author: 'operator@example.com' } },
      { seq: 10, type: 'session.note.updated', payload: { noteId: 9, markdown: 'Still obsolete.' } },
      { seq: 11, type: 'session.note.deleted', payload: { noteId: 9 } },
    ]);
    expect(markdown).not.toContain('Obsolete handoff.');
    expect(markdown).not.toContain('Still obsolete.');
    expect(markdown).toContain('Operator note deleted');
    expect(markdown).toContain('**Note sequence:** ` 9 `');
  });

  it('formats metadata, messages, tool activity, service messages, and approval outcomes', () => {
    const events: EventRow[] = [
      { seq: 8, type: 'session.state', payload: { state: 'dead' } },
      {
        seq: 7,
        type: 'approval.decided',
        payload: { approvalId: 'approval-1', status: 'approved', decidedBy: 'operator@example.com' },
      },
      message(5, 'agent', { t: 'service', text: 'Runner reconnected' }),
      message(4, 'agent', { t: 'tool-call-end', call: 'call-1', output: 'all good\n```\nstill safe' }),
      message(3, 'agent', {
        t: 'tool-call-start',
        call: 'call-1',
        name: 'Bash',
        title: 'Run checks',
        description: 'Execute the focused test',
        args: { command: 'pnpm test' },
      }),
      message(2, 'agent', { t: 'text', text: 'I will run the checks.' }),
      message(1, 'user', { t: 'text', text: 'Please verify the release.' }),
      {
        seq: 6,
        type: 'approval.requested',
        payload: {
          id: 'approval-1',
          kind: 'tool',
          title: 'Run command',
          payload: { toolName: 'Bash', input: { command: 'pnpm test' } },
          risk: 'low',
          requestedAt: Date.parse('2026-07-12T00:00:06.000Z'),
        },
      },
      message(1, 'user', { t: 'text', text: 'duplicate must be removed' }),
    ];

    const markdown = formatSessionTranscript(session, events);

    expect(markdown).toContain('# Release audit');
    expect(markdown).toContain('## Session metadata');
    expect(markdown).toContain('**State:** ` dead `');
    expect(markdown).toContain('**Agent:** ` codex `');
    expect(markdown).toContain('### User');
    expect(markdown).toContain('Please verify the release.');
    expect(markdown).not.toContain('duplicate must be removed');
    expect(markdown).toContain('### Agent');
    expect(markdown).toContain('I will run the checks.');
    expect(markdown).toContain('### Tool call · Bash');
    expect(markdown).toContain('"command": "pnpm test"');
    expect(markdown).toContain('### Tool result · Bash');
    expect(markdown).toContain('all good\n```\nstill safe');
    expect(markdown).toContain('### Service');
    expect(markdown).toContain('Runner reconnected');
    expect(markdown).toContain('### Approval requested · Run command');
    expect(markdown).toContain('**Status at export:** approved');
    expect(markdown).toContain('### Approval outcome');
    expect(markdown).toContain('**Decided by:** ` operator@example.com `');

    expect(markdown.indexOf('Please verify the release.')).toBeLessThan(markdown.indexOf('I will run the checks.'));
    expect(markdown.indexOf('I will run the checks.')).toBeLessThan(markdown.indexOf('### Tool call · Bash'));
    expect(markdown.indexOf('### Tool call · Bash')).toBeLessThan(markdown.indexOf('### Tool result · Bash'));
    expect(markdown.indexOf('### Tool result · Bash')).toBeLessThan(markdown.indexOf('### Service'));
    expect(markdown.indexOf('### Service')).toBeLessThan(markdown.indexOf('### Approval requested'));
    expect(markdown.indexOf('### Approval requested')).toBeLessThan(markdown.indexOf('### Approval outcome'));
  });

  it('builds a bounded filename without path separators or reserved characters', () => {
    const filename = sessionTranscriptFilename({
      ...session,
      id: 'session/../../unsafe',
      title: ' ../Release: audit*? <prod> | "night"  ',
    });

    expect(filename).toBe('Release-audit-prod-night-session-unsafe.md');
    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(filename).not.toContain('..');
  });
});
