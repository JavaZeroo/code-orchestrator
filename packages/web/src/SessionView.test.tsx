import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRow } from './api';
import {
  ForkAction,
  isSessionForkable,
  isSessionResumable,
  LoadEarlierAction,
  normalizeSessionTitle,
  ResumeAction,
  SESSION_TITLE_MAX_LENGTH,
  sessionArchiveMode,
  SessionArchiveAction,
  SessionNoteComposer,
  sessionNoteAction,
  SessionTitleEditor,
  TranscriptExportAction,
  downloadSessionArtifact,
  canDownloadArtifact,
} from './SessionView';

const session: SessionRow = {
  id: 'session-1',
  machineId: 'runner-1',
  agent: 'claude',
  model: 'claude-sonnet',
  cwd: '/tmp/work',
  title: null,
  state: 'dead',
  nativeSessionId: 'native-1',
  runId: null,
  nodeId: null,
  projectId: null,
  containerId: null,
  usage: null,
  archivedAt: null,
  createdAt: '2026-07-11T00:00:00Z',
};

describe('SessionView resume action', () => {
  it('shows resume only for eligible dead manual sessions on an online original runner', () => {
    expect(isSessionResumable(session, 'dead', true)).toBe(true);
    expect(isSessionResumable(session, 'idle', true)).toBe(false);
    expect(isSessionResumable({ ...session, runId: 'run-1' }, 'dead', true)).toBe(false);
    expect(isSessionResumable({ ...session, containerId: 'container-1' }, 'dead', true)).toBe(false);
    expect(isSessionResumable({ ...session, archivedAt: '2026-07-11T04:00:00Z' }, 'dead', true)).toBe(false);
    expect(isSessionResumable({ ...session, nativeSessionId: null }, 'dead', true)).toBe(false);
    expect(isSessionResumable(session, 'dead', false)).toBe(false);

    const visible = renderToStaticMarkup(<ResumeAction visible resuming={false} onResume={vi.fn()} />);
    const hidden = renderToStaticMarkup(<ResumeAction visible={false} resuming={false} onResume={vi.fn()} />);
    expect(visible).toContain('恢复会话');
    expect(hidden).not.toContain('恢复会话');
  });

  it('disables the action while waiting for a runner state update', () => {
    const markup = renderToStaticMarkup(<ResumeAction visible resuming onResume={vi.fn()} />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('恢复中…');
  });
});

describe('SessionView fork action', () => {
  it('shows fork for eligible idle or dead manual sessions on the online original runner', () => {
    expect(isSessionForkable({ ...session, state: 'idle' }, 'idle', true)).toBe(true);
    expect(isSessionForkable(session, 'dead', true)).toBe(true);
    expect(isSessionForkable(session, 'thinking', true)).toBe(false);
    expect(isSessionForkable({ ...session, runId: 'run-1' }, 'dead', true)).toBe(false);
    expect(isSessionForkable({ ...session, containerId: 'container-1' }, 'dead', true)).toBe(false);
    expect(isSessionForkable({ ...session, archivedAt: '2026-07-11T04:00:00Z' }, 'dead', true)).toBe(false);
    expect(isSessionForkable({ ...session, nativeSessionId: null }, 'dead', true)).toBe(false);
    expect(isSessionForkable(session, 'dead', false)).toBe(false);

    const visible = renderToStaticMarkup(<ForkAction visible forking={false} onFork={vi.fn()} />);
    const hidden = renderToStaticMarkup(<ForkAction visible={false} forking={false} onFork={vi.fn()} />);
    expect(visible).toContain('分叉会话');
    expect(hidden).not.toContain('分叉会话');
  });

  it('disables the action while the independent target is being created', () => {
    const markup = renderToStaticMarkup(<ForkAction visible forking onFork={vi.fn()} />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('分叉中…');
  });
});

describe('SessionView archive action', () => {
  it('offers archive only for finished manual sessions and restore for archived sessions', () => {
    expect(sessionArchiveMode(session, 'dead')).toBe('archive');
    expect(sessionArchiveMode(session, 'idle')).toBeNull();
    expect(sessionArchiveMode({ ...session, runId: 'run-1' }, 'dead')).toBeNull();
    expect(sessionArchiveMode({ ...session, archivedAt: '2026-07-11T04:00:00Z' }, 'dead')).toBe('restore');

    const archive = renderToStaticMarkup(<SessionArchiveAction mode="archive" updating={false} onChange={vi.fn()} />);
    const restore = renderToStaticMarkup(<SessionArchiveAction mode="restore" updating={false} onChange={vi.fn()} />);
    const hidden = renderToStaticMarkup(<SessionArchiveAction mode={null} updating={false} onChange={vi.fn()} />);
    expect(archive).toContain('归档');
    expect(restore).toContain('移出归档');
    expect(hidden).toBe('');
  });

  it('disables archive state changes while the request is pending', () => {
    const markup = renderToStaticMarkup(<SessionArchiveAction mode="archive" updating onChange={vi.fn()} />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('归档中…');
  });
});

describe('SessionView earlier history action', () => {
  it('shows the action only while an earlier page is available', () => {
    const visible = renderToStaticMarkup(
      <LoadEarlierAction visible loading={false} onLoad={vi.fn()} />,
    );
    const hidden = renderToStaticMarkup(
      <LoadEarlierAction visible={false} loading={false} onLoad={vi.fn()} />,
    );

    expect(visible).toContain('加载更早消息');
    expect(hidden).toBe('');
  });

  it('disables repeated requests while an earlier page is loading', () => {
    const markup = renderToStaticMarkup(
      <LoadEarlierAction visible loading onLoad={vi.fn()} />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('加载中…');
  });
});

describe('SessionView transcript export action', () => {
  it('is always available and disables repeated exports while history is loading', () => {
    const ready = renderToStaticMarkup(
      <TranscriptExportAction exporting={false} onExport={vi.fn()} />,
    );
    const exporting = renderToStaticMarkup(
      <TranscriptExportAction exporting onExport={vi.fn()} />,
    );

    expect(ready).toContain('导出记录');
    expect(ready).not.toContain('disabled=""');
    expect(exporting).toContain('disabled=""');
    expect(exporting).toContain('导出中…');
  });
});

describe('SessionView artifact download action', () => {
  it('uses the server filename and downloads the returned bytes', async () => {
    const request = vi.fn().mockResolvedValue(new Response('artifact bytes', {
      headers: { 'content-disposition': "attachment; filename*=UTF-8''final%20report.txt" },
    }));
    const download = vi.fn();
    await downloadSessionArtifact('session-1', 'out/report.txt', request, download);
    expect(request).toHaveBeenCalledWith('session-1', 'out/report.txt');
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'final report.txt');
  });

  it('allows one download only after a path is entered and while idle', () => {
    expect(canDownloadArtifact('   ', false)).toBe(false);
    expect(canDownloadArtifact('out/result.bin', true)).toBe(false);
    expect(canDownloadArtifact('out/result.bin', false)).toBe(true);
  });
});

describe('SessionView title editor', () => {
  const handlers = {
    onEdit: vi.fn(),
    onDraftChange: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
  };

  it('shows the persisted title with an inline rename action', () => {
    const markup = renderToStaticMarkup(
      <SessionTitleEditor
        title="Release follow-up"
        draft="Release follow-up"
        editing={false}
        saving={false}
        {...handlers}
      />,
    );

    expect(markup).toContain('Release follow-up');
    expect(markup).toContain('aria-label="重命名会话"');
  });

  it('renders a bounded title input and rejects empty or oversized values', () => {
    const markup = renderToStaticMarkup(
      <SessionTitleEditor
        title="Release follow-up"
        draft="  Incident review  "
        editing
        saving={false}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="会话标题"');
    expect(markup).toContain(`maxLength="${SESSION_TITLE_MAX_LENGTH}"`);
    expect(normalizeSessionTitle('  Incident review  ')).toBe('Incident review');
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('x'.repeat(SESSION_TITLE_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('standalone session note composer', () => {
  it('remains available independently of agent state and disables blank notes', () => {
    const empty = renderToStaticMarkup(
      <SessionNoteComposer value="   " saving={false} onChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const ready = renderToStaticMarkup(
      <SessionNoteComposer value="Dead session handoff" saving={false} onChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(empty).toContain('不会发送给 Agent');
    expect(empty).toContain('disabled=""');
    expect(ready).not.toContain('disabled=""');
  });

  it('reports action success and failure without dispatching another operation', async () => {
    const note = {
      seq: 7,
      type: 'session.note' as const,
      sessionId: 'session-1',
      payload: { markdown: 'Handoff', author: 'operator@example.com' },
    };
    const success = vi.fn();
    const error = vi.fn();
    const request = vi.fn().mockResolvedValue({ note });
    await expect(sessionNoteAction('session-1', 'Handoff', { request, success, error })).resolves.toEqual(note);
    expect(request).toHaveBeenCalledWith('session-1', 'Handoff');
    expect(success).toHaveBeenCalledWith('会话备注已添加');

    const failure = new Error('not found');
    const rejected = vi.fn().mockRejectedValue(failure);
    await expect(sessionNoteAction('missing', 'Handoff', { request: rejected, success, error })).rejects.toBe(failure);
    expect(error).toHaveBeenCalledWith('添加会话备注失败：not found');
  });
});
