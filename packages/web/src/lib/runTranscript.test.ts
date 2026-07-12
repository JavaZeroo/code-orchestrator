import { describe, expect, it, vi } from 'vitest';
import type {
  EventRow,
  ForgeRefRow,
  NodeStateRow,
  RunRow,
  RunThreadPage,
  SessionEnvelope,
  WorkflowDefRow,
} from '../api';
import {
  collectRunTranscriptSnapshot,
  exportRunTranscript,
  formatRunTranscript,
  runTranscriptFilename,
  type FetchRunThreadPage,
  type RunTranscriptSnapshot,
} from './transcript';

const run: RunRow = {
  id: 'run-12345678',
  defId: 'workflow-1',
  defName: 'Release workflow',
  projectId: 'project-1',
  title: 'Production release',
  status: 'done',
  context: {
    vars: { env: 'production', version: '2026.07' },
    outputs: { build: 'Build completed' },
  },
  startedAt: '2026-07-12T00:00:00.000Z',
  endedAt: '2026-07-12T00:10:00.000Z',
  archivedAt: null,
};

const def: WorkflowDefRow = {
  id: 'workflow-1',
  name: 'Release workflow',
  version: 3,
  graph: {
    name: 'Release workflow',
    nodes: [
      {
        id: 'build',
        type: 'agent',
        title: 'Build {{vars.env}}',
        cli: 'codex',
        prompt: 'Build the release',
      },
      {
        id: 'approve',
        type: 'gate',
        title: 'Release approval',
        approvers: ['ops@example.com'],
        onTimeout: 'notify',
      },
    ],
    edges: [['build', 'approve']],
  },
  createdVia: 'manual',
  projectId: 'project-1',
  archived: 'no',
  createdAt: '2026-07-11T00:00:00.000Z',
};

const nodes: NodeStateRow[] = [
  {
    runId: run.id,
    nodeId: 'build',
    status: 'done',
    sessionId: 'session-build',
    output: { summary: 'Build completed' },
    model: 'gpt-5',
    updatedAt: '2026-07-12T00:08:00.000Z',
  },
  {
    runId: run.id,
    nodeId: 'approve',
    status: 'done',
    sessionId: null,
    output: { verdict: 'approve' },
    model: null,
    updatedAt: '2026-07-12T00:09:00.000Z',
  },
];

const forgeRef: ForgeRefRow = {
  id: 'forge-ref-1',
  forge: 'github',
  kind: 'pr',
  repo: 'acme/widgets',
  number: 42,
  runId: run.id,
  nodeId: 'build',
  sessionId: 'session-build',
  ciStatus: 'passed',
  snapshot: { state: 'open', head: 'release-2026.07' },
  active: 'yes',
};

function event(seq: number, payload: unknown = { marker: seq }): EventRow {
  return { seq, type: 'run.status', payload };
}

function message(
  seq: number,
  role: SessionEnvelope['role'],
  ev: SessionEnvelope['ev'],
): EventRow {
  return {
    seq,
    type: 'session.message',
    sessionId: 'session-build',
    payload: {
      id: `message-${seq}`,
      time: Date.parse('2026-07-12T00:00:00.000Z') + seq * 1_000,
      role,
      ev,
    } satisfies SessionEnvelope,
  };
}

function page(
  events: EventRow[],
  hasEarlier: boolean,
  before: number | null,
): RunThreadPage {
  return { run, def, nodes, events, forgeRefs: [forgeRef], page: { hasEarlier, before } };
}

describe('workflow run transcript collection', () => {
  it('walks every backward page, deduplicates overlaps, and returns chronological events', async () => {
    const fetchPage = vi.fn<FetchRunThreadPage>(async (_runId, cursor) => {
      if (!cursor) return page([event(4, { source: 'newest' }), event(5)], true, 4);
      if (cursor.before === 4) return page([event(2), event(3), event(4, { source: 'overlap' })], true, 2);
      return page([event(1), event(2)], false, null);
    });

    const snapshot = await collectRunTranscriptSnapshot(run.id, fetchPage);

    expect(fetchPage).toHaveBeenNthCalledWith(1, run.id);
    expect(fetchPage).toHaveBeenNthCalledWith(2, run.id, { before: 4 });
    expect(fetchPage).toHaveBeenNthCalledWith(3, run.id, { before: 2 });
    expect(snapshot.events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.events.find((row) => row.seq === 4)?.payload).toEqual({ source: 'newest' });
    expect(snapshot.run).toBe(run);
    expect(snapshot.forgeRefs).toEqual([forgeRef]);
  });

  it('does not download a partial record when an earlier page fails', async () => {
    const fetchPage = vi.fn<FetchRunThreadPage>()
      .mockResolvedValueOnce(page([event(3), event(4)], true, 3))
      .mockRejectedValueOnce(new Error('run history unavailable'));
    const download = vi.fn();

    await expect(exportRunTranscript(run.id, fetchPage, download)).rejects.toThrow('run history unavailable');
    expect(fetchPage).toHaveBeenNthCalledWith(2, run.id, { before: 3 });
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads only after the oldest run event page succeeds', async () => {
    let reachedOldestPage = false;
    const fetchPage = vi.fn<FetchRunThreadPage>(async (_runId, cursor) => {
      if (!cursor) return page([message(2, 'agent', { t: 'text', text: 'Latest result' })], true, 2);
      reachedOldestPage = true;
      return page([message(1, 'user', { t: 'text', text: 'Earliest request' })], false, null);
    });
    const download = vi.fn(() => {
      expect(reachedOldestPage).toBe(true);
    });

    const transcript = await exportRunTranscript(run.id, fetchPage, download);

    expect(transcript.events.map((row) => row.seq)).toEqual([1, 2]);
    expect(transcript.markdown.indexOf('Earliest request')).toBeLessThan(transcript.markdown.indexOf('Latest result'));
    expect(download).toHaveBeenCalledWith('Production-release-run-12345678.md', transcript.markdown);
  });
});

describe('workflow run transcript Markdown', () => {
  it('omits deleted note content but retains its audit tombstone', () => {
    const markdown = formatRunTranscript({
      run, def, nodes, forgeRefs: [],
      events: [
        { seq: 20, type: 'run.note', runId: run.id, payload: { markdown: 'Obsolete decision.', author: 'operator@example.com' } },
        { seq: 21, type: 'run.note.updated', runId: run.id, payload: { noteId: 20, markdown: 'Still obsolete.' } },
        { seq: 22, type: 'run.note.deleted', runId: run.id, payload: { noteId: 20 } },
      ],
    });
    expect(markdown).not.toContain('Obsolete decision.');
    expect(markdown).not.toContain('Still obsolete.');
    expect(markdown).toContain('Operator note deleted');
    expect(markdown).toContain('**Note sequence:** ` 20 `');
  });

  it('formats run metadata, node outcomes, messages, tool activity, approvals, and forge references', () => {
    const events: EventRow[] = [
      {
        seq: 12,
        type: 'run.note',
        payload: {
          markdown: '**Hold** deployment until the change window opens.',
          author: 'operator@example.com',
        },
      },
      { seq: 11, type: 'run.finished', payload: { status: 'done' } },
      { seq: 10, type: 'run.node.state', payload: { nodeId: 'approve', status: 'done' } },
      {
        seq: 9,
        type: 'forge.ref_registered',
        sessionId: 'session-build',
        payload: { forge: 'github', repo: 'acme/widgets', number: 42, nodeId: 'build' },
      },
      {
        seq: 8,
        type: 'approval.decided',
        payload: { approvalId: 'approval-1', status: 'approved', decidedBy: 'operator@example.com' },
      },
      {
        seq: 7,
        type: 'approval.requested',
        payload: {
          id: 'approval-1',
          kind: 'gate',
          runId: run.id,
          nodeId: 'approve',
          title: 'Release to production',
          payload: { approvers: ['ops@example.com'] },
          requestedAt: Date.parse('2026-07-12T00:00:07.000Z'),
        },
      },
      message(6, 'agent', { t: 'tool-call-end', call: 'call-1', output: 'tests passed\n```\nartifact ready' }),
      message(5, 'agent', {
        t: 'tool-call-start',
        call: 'call-1',
        name: 'Bash',
        title: 'Run release checks',
        description: 'Validate the release artifact',
        args: { command: 'pnpm test' },
      }),
      message(4, 'agent', { t: 'text', text: 'I will validate the release.' }),
      message(3, 'user', { t: 'text', text: 'Deploy the release.' }),
      {
        seq: 2,
        type: 'run.node.state',
        payload: { nodeId: 'build', status: 'running', sessionId: 'session-build' },
      },
      { seq: 1, type: 'run.started', payload: { defId: def.id, vars: run.context.vars } },
    ];
    const snapshot: RunTranscriptSnapshot = { run, def, nodes, events, forgeRefs: [forgeRef] };

    const markdown = formatRunTranscript(snapshot);

    expect(markdown).toContain('# Production release');
    expect(markdown).toContain('## Run metadata');
    expect(markdown).toContain('**Status:** ` done `');
    expect(markdown).toContain('**Workflow version:** ` 3 `');
    expect(markdown).toContain('"env": "production"');
    expect(markdown).toContain('## Node outcomes');
    expect(markdown).toContain('### Build production');
    expect(markdown).toContain('Build completed');
    expect(markdown).toContain('### Release approval');
    expect(markdown).toContain('"verdict": "approve"');
    expect(markdown).toContain('## Forge references');
    expect(markdown).toContain('### Pull request · github acme/widgets#42');
    expect(markdown).toContain('https://github.com/acme/widgets/pull/42');
    expect(markdown).toContain('**CI status:** ` passed `');
    expect(markdown).toContain('## Timeline');
    expect(markdown).toContain('### Node · Build production · User');
    expect(markdown).toContain('Deploy the release.');
    expect(markdown).toContain('### Node · Build production · Agent');
    expect(markdown).toContain('### Node · Build production · Tool call · Bash');
    expect(markdown).toContain('"command": "pnpm test"');
    expect(markdown).toContain('### Node · Build production · Tool result · Bash');
    expect(markdown).toContain('tests passed\n```\nartifact ready');
    expect(markdown).toContain('### Node · Release approval · Approval requested · Release to production');
    expect(markdown).toContain('**Status at export:** approved');
    expect(markdown).toContain('### Node · Release approval · Approval outcome');
    expect(markdown).toContain('**Decided by:** ` operator@example.com `');
    expect(markdown).toContain('### Node · Build production · Forge reference registered');
    expect(markdown).toContain('### Run · Run finished');
    expect(markdown).toContain('### Run · Operator note');
    expect(markdown).toContain('**Author:** ` operator@example.com `');
    expect(markdown).toContain('**Hold** deployment until the change window opens.');

    expect(markdown.indexOf('Deploy the release.')).toBeLessThan(markdown.indexOf('I will validate the release.'));
    expect(markdown.indexOf('I will validate the release.')).toBeLessThan(markdown.indexOf('Tool call · Bash'));
    expect(markdown.indexOf('Tool call · Bash')).toBeLessThan(markdown.indexOf('Tool result · Bash'));
    expect(markdown.indexOf('Tool result · Bash')).toBeLessThan(markdown.indexOf('Approval requested'));
    expect(markdown.indexOf('Approval requested')).toBeLessThan(markdown.indexOf('Approval outcome'));
    expect(markdown.indexOf('Approval outcome')).toBeLessThan(markdown.indexOf('Forge reference registered'));
    expect(markdown.indexOf('Run finished')).toBeLessThan(markdown.indexOf('Operator note'));
  });

  it('builds a bounded filename without path separators or reserved characters', () => {
    const filename = runTranscriptFilename({
      ...run,
      id: 'run/../../unsafe',
      title: ' ../Release: audit*? <prod> | "night"  ',
    }, def);

    expect(filename).toBe('Release-audit-prod-night-run-unsafe.md');
    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(filename).not.toContain('..');
    expect(filename.length).toBeLessThanOrEqual(108);
  });
});
