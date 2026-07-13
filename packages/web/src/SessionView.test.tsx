import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { isWorkspaceImagePreviewCandidate, isWorkspaceTextPreviewCandidate, WORKSPACE_IMAGE_PREVIEW_MAX_BYTES, WORKSPACE_TEXT_PREVIEW_MAX_BYTES, type SessionRow } from './api';
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
  extractWorkspaceArchiveHere,
  isWorkspaceArchive,
  WorkspaceBrowserEntries,
  WorkspaceCreateFileAction,
  WorkspaceCreateFolderAction,
  WorkspaceFilePreview,
  WorkspaceSearchResults,
  WorkspaceContentSearchResults,
  WorkspaceUploadAction,
  uploadSelectedWorkspaceFile,
  saveWorkspaceTextFile,
  setWorkspaceFileExecutable,
  createNamedWorkspaceFolder,
  createNamedWorkspaceFile,
  requestWorkspaceFolderName,
  renameNamedWorkspaceEntry,
  requestWorkspaceEntryName,
  moveNamedWorkspaceEntry,
  requestWorkspaceMoveDestination,
  copyNamedWorkspaceEntry,
  requestWorkspaceCopyDestination,
  replaceWorkspaceImageObjectUrl,
  WORKSPACE_UPLOAD_MAX_BYTES,
  workspaceFileOpenMode,
  workspaceChildPath,
  workspaceParentPath,
  workspaceSearchTarget,
  downloadSessionArtifact,
  downloadSessionDirectoryArchive,
  deleteConfirmedWorkspaceEntry,
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

  it('downloads a directory through the archive API using the archive filename', async () => {
    const request = vi.fn().mockResolvedValue(new Response('archive bytes', {
      headers: { 'content-disposition': "attachment; filename*=UTF-8''reports.tar.gz" },
    }));
    const download = vi.fn();
    await downloadSessionDirectoryArchive('session-1', 'out/reports', request, download);
    expect(request).toHaveBeenCalledWith('session-1', 'out/reports');
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'reports.tar.gz');
  });

  it('renders discoverable directories and downloadable files', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBrowserEntries
        path=""
        entries={[{ name: 'reports', type: 'directory' }, { name: 'result.bin', type: 'file', size: 42 }]}
        disabled={false}
        onDirectory={vi.fn()}
        onFile={vi.fn()}
        onDownloadDirectory={vi.fn()}
        onExtractArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onCopy={vi.fn()}
        onExecutableChange={vi.fn()}
      />,
    );
    expect(markup).toContain('reports');
    expect(markup).toContain('result.bin');
    expect(markup).toContain('42 B');
    expect(markup).toContain('添加 result.bin 的可执行权限');
    expect(workspaceChildPath('', 'reports')).toBe('reports');
    expect(workspaceChildPath('reports', 'daily')).toBe('reports/daily');
    expect(workspaceParentPath('reports/daily')).toBe('reports');
    expect(workspaceParentPath('reports')).toBe('');
    expect(markup).toContain('删除 result.bin');
    expect(markup).toContain('删除 reports');
    expect(markup).toContain('重命名 reports');
    expect(markup).toContain('重命名 result.bin');
    expect(markup).toContain('移动 reports');
    expect(markup).toContain('移动 result.bin');
    expect(markup).toContain('复制 reports');
    expect(markup).toContain('复制 result.bin');
    expect(markup).toContain('下载 reports');
    expect(markup).not.toContain('下载 result.bin');
  });

  it('offers Extract here only for .tar.gz files and calls the extraction API', async () => {
    const onExtractArchive = vi.fn();
    const archive = { name: 'results.TAR.GZ', type: 'file' as const, size: 42 };
    const markup = renderToStaticMarkup(
      <WorkspaceBrowserEntries
        path="uploads"
        entries={[archive, { name: 'result.zip', type: 'file', size: 12 }]}
        disabled={false}
        onDirectory={vi.fn()}
        onFile={vi.fn()}
        onDownloadDirectory={vi.fn()}
        onExtractArchive={onExtractArchive}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onCopy={vi.fn()}
        onExecutableChange={vi.fn()}
      />,
    );
    expect(markup).toContain('在此处解压 results.TAR.GZ');
    expect(markup).not.toContain('在此处解压 result.zip');
    expect(isWorkspaceArchive(archive)).toBe(true);
    expect(isWorkspaceArchive({ name: 'results.tar.gz', type: 'directory' })).toBe(false);

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'uploads/results.tar.gz', entries: 3 });
    await expect(extractWorkspaceArchiveHere('session-1', 'uploads/results.tar.gz', request)).resolves.toBe(3);
    expect(request).toHaveBeenCalledWith('session-1', 'uploads/results.tar.gz');
  });

  it('renders executable state and persists either side of the file toggle', async () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBrowserEntries
        path="scripts"
        entries={[{ name: 'run.sh', type: 'file', size: 12, executable: true }]}
        disabled={false}
        onDirectory={vi.fn()}
        onFile={vi.fn()}
        onDownloadDirectory={vi.fn()}
        onExtractArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onCopy={vi.fn()}
        onExecutableChange={vi.fn()}
      />,
    );
    expect(markup).toContain('移除 run.sh 的可执行权限');
    expect(markup).toContain('aria-pressed="true"');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'scripts/run.sh', executable: false });
    await expect(setWorkspaceFileExecutable('session-1', 'scripts/run.sh', false, request)).resolves.toBe(false);
    expect(request).toHaveBeenCalledWith('session-1', 'scripts/run.sh', false);
  });

  it('renders recursive search paths that can be opened directly', () => {
    const onSelect = vi.fn();
    const matches = [
      { path: 'reports/archive', type: 'directory' as const },
      { path: 'reports/final.md', type: 'file' as const, size: 42 },
    ];
    const markup = renderToStaticMarkup(
      <WorkspaceSearchResults matches={matches} disabled={false} onSelect={onSelect} />,
    );
    expect(markup).toContain('reports/archive');
    expect(markup).toContain('reports/final.md');
    expect(markup).toContain('42 B');
    expect(workspaceSearchTarget(matches[0]!)).toEqual({ kind: 'directory', path: 'reports/archive' });
    expect(workspaceSearchTarget(matches[1]!)).toEqual({
      kind: 'file', path: 'reports/final.md', entry: { name: 'final.md', type: 'file', size: 42 },
    });
  });

  it('renders content previews with file lines as selectable results', () => {
    const matches = [{ path: 'src/main.ts', line: 7, preview: 'const releaseReady = true;' }];
    const markup = renderToStaticMarkup(
      <WorkspaceContentSearchResults matches={matches} disabled={false} onSelect={vi.fn()} />,
    );
    expect(markup).toContain('src/main.ts:7');
    expect(markup).toContain('const releaseReady = true;');
    const preview = renderToStaticMarkup(
      <WorkspaceFilePreview path="src/main.ts" line={2} text={'first\nrelease ready\nlast'} downloading={false} onBack={vi.fn()} onDownload={vi.fn()} />,
    );
    expect(preview).toContain('/src/main.ts:2');
    expect(preview).toContain('bg-accent/15');
  });

  it('renames a file or folder with a single-entry name', async () => {
    const entry = { name: 'draft.txt', type: 'file' as const, size: 5 };
    const onRename = vi.fn();
    requestWorkspaceEntryName(entry, onRename, () => 'final.txt');
    expect(onRename).toHaveBeenCalledWith(entry, 'final.txt');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/final.txt' });
    await expect(renameNamedWorkspaceEntry('session-1', 'reports/draft.txt', ' final.txt ', request))
      .resolves.toBe('reports/final.txt');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/draft.txt', 'final.txt');
  });

  it('rejects rename values that address another directory', async () => {
    const request = vi.fn();
    for (const name of ['', '.', '..', '../escape', 'nested/file', 'nested\\file']) {
      await expect(renameNamedWorkspaceEntry('session-1', 'reports/draft.txt', name, request))
        .rejects.toThrow('新名称');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('moves a file or folder to a workspace-relative destination path', async () => {
    const entry = { name: 'draft', type: 'directory' as const };
    const onMove = vi.fn();
    requestWorkspaceMoveDestination(entry, 'reports', onMove, () => 'archive/draft');
    expect(onMove).toHaveBeenCalledWith(entry, 'archive/draft');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'archive/draft' });
    await expect(moveNamedWorkspaceEntry('session-1', 'reports/draft', ' archive/draft ', request))
      .resolves.toBe('archive/draft');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/draft', 'archive/draft');
  });

  it('rejects move destinations outside the workspace', async () => {
    const request = vi.fn();
    for (const destination of ['', '.', '..', '/archive/draft', '../escape', 'archive/../draft', 'archive\\draft', 'archive//draft']) {
      await expect(moveNamedWorkspaceEntry('session-1', 'reports/draft', destination, request))
        .rejects.toThrow('目标路径');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('copies a file or folder to a prompted workspace-relative destination', async () => {
    const entry = { name: 'draft', type: 'directory' as const };
    const onCopy = vi.fn();
    requestWorkspaceCopyDestination(entry, 'reports', onCopy, (_message, initial) => {
      expect(initial).toBe('reports/draft-copy');
      return 'archive/draft';
    });
    expect(onCopy).toHaveBeenCalledWith(entry, 'archive/draft');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'archive/draft' });
    await expect(copyNamedWorkspaceEntry('session-1', 'reports/draft', ' archive/draft ', request))
      .resolves.toBe('archive/draft');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/draft', 'archive/draft');
  });

  it('rejects copy destinations outside the workspace', async () => {
    const request = vi.fn();
    for (const destination of ['', '.', '..', '/archive/draft', '../escape', 'archive/../draft', 'archive\\draft', 'archive//draft']) {
      await expect(copyNamedWorkspaceEntry('session-1', 'reports/draft', destination, request))
        .rejects.toThrow('目标路径');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('deletes files and folder trees only after type-aware confirmation', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/old.bin' });
    const confirmDelete = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await expect(deleteConfirmedWorkspaceEntry('session-1', 'reports/old.bin', 'file', request, confirmDelete)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(confirmDelete).toHaveBeenCalledWith('reports/old.bin', 'file');

    await expect(deleteConfirmedWorkspaceEntry('session-1', 'reports/archive', 'directory', request, confirmDelete)).resolves.toBe(true);
    expect(confirmDelete).toHaveBeenCalledWith('reports/archive', 'directory');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/archive');
  });

  it('warns that confirmed folder deletion removes all contained files', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/archive' });
    const confirmDelete = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmDelete);
    try {
      await expect(deleteConfirmedWorkspaceEntry('session-1', 'reports/archive', 'directory', request)).resolves.toBe(true);
      expect(confirmDelete).toHaveBeenCalledWith(
        '确定删除工作区文件夹 /reports/archive 及其中的所有内容？此操作无法撤销。',
      );
      expect(request).toHaveBeenCalledWith('session-1', 'reports/archive');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('creates a named folder in the current directory from the browser action', async () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCreateFolderAction disabled={false} creating={false} onCreate={vi.fn()} />,
    );
    expect(markup).toContain('新建文件夹');

    const onCreate = vi.fn();
    requestWorkspaceFolderName(onCreate, () => 'daily results');
    expect(onCreate).toHaveBeenCalledWith('daily results');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/daily results' });
    await expect(createNamedWorkspaceFolder('session-1', 'reports', ' daily results ', request))
      .resolves.toBe('reports/daily results');
    expect(request).toHaveBeenCalledWith('session-1', 'reports/daily results');
  });

  it('creates an empty UTF-8 text file in the current directory from the browser action', async () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCreateFileAction disabled={false} creating={false} onCreate={vi.fn()} />,
    );
    expect(markup).toContain('新建文件');

    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/notes.md', size: 0 });
    await expect(createNamedWorkspaceFile('session-1', 'reports', ' notes.md ', [], request))
      .resolves.toBe('reports/notes.md');
    expect(request).toHaveBeenCalledOnce();
    const [sessionId, path, contents] = request.mock.calls[0]!;
    expect(sessionId).toBe('session-1');
    expect(path).toBe('reports/notes.md');
    expect(contents).toBeInstanceOf(Blob);
    expect(await (contents as Blob).text()).toBe('');
    expect((contents as Blob).type).toBe('text/plain;charset=utf-8');
  });

  it('rejects invalid or conflicting file names before writing', async () => {
    const request = vi.fn();
    const entries = [
      { name: 'notes.md', type: 'file' as const, size: 12 },
      { name: 'archive', type: 'directory' as const },
    ];
    for (const name of ['', '.', '..', '../escape', 'nested/file', 'nested\\file']) {
      await expect(createNamedWorkspaceFile('session-1', 'reports', name, entries, request))
        .rejects.toThrow('文件名称');
    }
    await expect(createNamedWorkspaceFile('session-1', 'reports', 'notes.md', entries, request))
      .rejects.toThrow('已存在');
    await expect(createNamedWorkspaceFile('session-1', 'reports', 'archive', entries, request))
      .rejects.toThrow('已存在');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects folder names that could address a different directory', async () => {
    const request = vi.fn();
    for (const name of ['', '.', '..', '../escape', 'nested/folder', 'nested\\folder']) {
      await expect(createNamedWorkspaceFolder('session-1', 'reports', name, request)).rejects.toThrow('文件夹名称');
    }
    expect(request).not.toHaveBeenCalled();
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

  it('offers inline preview for bounded supported images but not other binary files', () => {
    expect(isWorkspaceImagePreviewCandidate({ name: 'screenshot.png', type: 'file', size: 42 })).toBe(true);
    expect(isWorkspaceImagePreviewCandidate({ name: 'chart.webp', type: 'file', size: WORKSPACE_IMAGE_PREVIEW_MAX_BYTES })).toBe(true);
    expect(isWorkspaceImagePreviewCandidate({ name: 'diagram.svg', type: 'file', size: 42 })).toBe(false);
    expect(isWorkspaceImagePreviewCandidate({ name: 'archive.zip', type: 'file', size: 42 })).toBe(false);
    expect(isWorkspaceImagePreviewCandidate({ name: 'large.gif', type: 'file', size: WORKSPACE_IMAGE_PREVIEW_MAX_BYTES + 1 })).toBe(false);
  });

  it('keeps unsupported binary files on the download path', () => {
    expect(workspaceFileOpenMode({ name: 'report.md', type: 'file', size: 42 })).toBe('text-preview');
    expect(workspaceFileOpenMode({ name: 'screenshot.jpeg', type: 'file', size: 42 })).toBe('image-preview');
    expect(workspaceFileOpenMode({ name: 'diagram.svg', type: 'file', size: 42 })).toBe('download');
    expect(workspaceFileOpenMode({ name: 'archive.zip', type: 'file', size: 42 })).toBe('download');
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
    expect(markup).toContain('编辑');
  });

  it('renders an image preview with back navigation and explicit download', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceFilePreview
        path="screens/result.png"
        imageUrl="blob:workspace-image"
        downloading={false}
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(markup).toContain('返回目录列表');
    expect(markup).toContain('src="blob:workspace-image"');
    expect(markup).toContain('alt="工作区图片 screens/result.png"');
    expect(markup).toContain('下载');
    expect(markup).not.toContain('编辑');
  });

  it('revokes image object URLs when previews change or close', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      const first = replaceWorkspaceImageObjectUrl(undefined, new Blob(['first'], { type: 'image/png' }));
      const second = replaceWorkspaceImageObjectUrl(first, new Blob(['second'], { type: 'image/webp' }));
      const closed = replaceWorkspaceImageObjectUrl(second);

      expect(first).toBe('blob:first');
      expect(second).toBe('blob:second');
      expect(closed).toBeUndefined();
      expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'blob:first');
      expect(revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:second');
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it('writes exact UTF-8 text back to the same workspace path', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, path: 'reports/final.md', size: 16 });
    const text = '第一行\nsecond line\n';
    await saveWorkspaceTextFile('session-1', 'reports/final.md', text, request);

    expect(request).toHaveBeenCalledOnce();
    const [sessionId, path, contents] = request.mock.calls[0]!;
    expect(sessionId).toBe('session-1');
    expect(path).toBe('reports/final.md');
    expect(contents).toBeInstanceOf(Blob);
    expect(await (contents as Blob).text()).toBe(text);
    expect((contents as Blob).type).toBe('text/plain;charset=utf-8');
  });

  it('renders Save and Cancel only while editing, with the persisted text as the draft', () => {
    const preview = renderToStaticMarkup(
      <WorkspaceFilePreview
        path="reports/final.md"
        text="persisted"
        draft="changed"
        editing
        downloading={false}
        onBack={vi.fn()}
        onDownload={vi.fn()}
        onDraftChange={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(preview).toContain('工作区文件内容');
    expect(preview).toContain('changed');
    expect(preview).toContain('取消');
    expect(preview).toContain('保存');
    expect(preview).not.toContain('>编辑<');
  });

  it('rejects oversized UTF-8 edits before writing', async () => {
    const request = vi.fn();
    await expect(saveWorkspaceTextFile(
      'session-1',
      'reports/final.md',
      '界'.repeat(Math.floor(WORKSPACE_TEXT_PREVIEW_MAX_BYTES / 3) + 1),
      request,
    )).rejects.toThrow('编辑上限');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps workspace write failures observable to the editor', async () => {
    const request = vi.fn().mockRejectedValue(new Error('runner offline'));
    await expect(saveWorkspaceTextFile('session-1', 'reports/final.md', 'changed', request))
      .rejects.toThrow('runner offline');
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
    expect(markup).not.toContain('编辑');
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
