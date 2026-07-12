import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { isWorkspaceTextPreviewCandidate, WORKSPACE_TEXT_PREVIEW_MAX_BYTES, type SessionRow } from './api';
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
  WorkspaceBrowserEntries,
  WorkspaceFilePreview,
  WorkspaceUploadAction,
  uploadSelectedWorkspaceFile,
  WORKSPACE_UPLOAD_MAX_BYTES,
  workspaceChildPath,
  workspaceParentPath,
  downloadSessionArtifact,
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

  it('renders discoverable directories and downloadable files', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBrowserEntries
        entries={[{ name: 'reports', type: 'directory' }, { name: 'result.bin', type: 'file', size: 42 }]}
        disabled={false}
        onDirectory={vi.fn()}
        onFile={vi.fn()}
      />,
    );
    expect(markup).toContain('reports');
    expect(markup).toContain('result.bin');
    expect(markup).toContain('42 B');
    expect(workspaceChildPath('', 'reports')).toBe('reports');
    expect(workspaceChildPath('reports', 'daily')).toBe('reports/daily');
    expect(workspaceParentPath('reports/daily')).toBe('reports');
    expect(workspaceParentPath('reports')).toBe('');
  });

  it('offers one-file upload and targets the currently open directory', async () => {
    const markup = renderToStaticMarkup(
      <WorkspaceUploadAction disabled={false} uploading={false} onFile={vi.fn()} />,
    );
    expect(markup).toContain('上传文件');
    expect(markup).toContain('type="file"');
    expect(markup).not.toContain('multiple');

    const file = new File([new Uint8Array([0, 128, 255])], 'raw.bin');
    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/raw.bin', size: 3 });
    await expect(uploadSelectedWorkspaceFile('session-1', 'reports', file, request)).resolves.toBe('reports/raw.bin');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/raw.bin', file);
  });

  it('rejects oversized files before starting an upload', async () => {
    const file = { name: 'large.bin', size: WORKSPACE_UPLOAD_MAX_BYTES + 1 } as File;
    const request = vi.fn();
    await expect(uploadSelectedWorkspaceFile('session-1', '', file, request)).rejects.toThrow('上限');
    expect(request).not.toHaveBeenCalled();
  });

  it('only offers inline preview for bounded, recognized text files', () => {
    expect(isWorkspaceTextPreviewCandidate({ name: 'report.md', type: 'file', size: 42 })).toBe(true);
    expect(isWorkspaceTextPreviewCandidate({ name: 'Dockerfile', type: 'file', size: 42 })).toBe(true);
    expect(isWorkspaceTextPreviewCandidate({ name: 'result.bin', type: 'file', size: 42 })).toBe(false);
    expect(isWorkspaceTextPreviewCandidate({ name: 'report.txt', type: 'file', size: WORKSPACE_TEXT_PREVIEW_MAX_BYTES + 1 })).toBe(false);
    expect(isWorkspaceTextPreviewCandidate({ name: 'report.txt', type: 'file' })).toBe(false);
  });

  it('renders readable preview content with back navigation and explicit download', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceFilePreview
        path="reports/final.md"
        text={'# Final report\nReady to ship.'}
        downloading={false}
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(markup).toContain('返回目录列表');
    expect(markup).toContain('reports/final.md');
    expect(markup).toContain('# Final report');
    expect(markup).toContain('下载');
  });

  it('keeps download available when a preview cannot be loaded', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceFilePreview
        path="reports/final.txt"
        error="预览加载失败：network unavailable"
        downloading={false}
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(markup).toContain('预览加载失败');
    expect(markup).toContain('返回目录列表');
    expect(markup).toContain('下载');
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
