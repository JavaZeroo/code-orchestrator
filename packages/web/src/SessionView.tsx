import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronLeft, Code2, Copy, Download, File, FilePlus, Folder, FolderInput, FolderPlus, GitCompare, GitFork, NotebookPen, Pencil, RotateCcw, Search, Send, Square, Trash2, Upload, X } from 'lucide-react';
import { SESSION_NOTE_MAX_LENGTH } from '@co/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, isWorkspaceImagePreviewCandidate, isWorkspaceTextPreviewCandidate, WORKSPACE_TEXT_PREVIEW_MAX_BYTES, type ApprovalRequest, type SessionNoteEventRow, type SessionRow, type SessionUsage, type UserInputAnswers, type WorkspaceContentMatch, type WorkspaceEntry, type WorkspaceSearchMatch } from './api';
import { UnifiedDiff } from './components/DiffView';
import { RejectionFeedback, type ApprovalDecisionHandler } from './components/RejectionFeedback';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Badge, Input, StatusDot, Textarea, type BadgeTone } from './components/ui/primitives';
import { useSessionEvents } from './useEvents';
import { isCodexUserInputRequest, Timeline, type ApprovalItem } from './Timeline';
import { invalidate, useMachines } from './lib/queries';
import { exportSessionTranscript } from './lib/transcript';
import { fmtCost, fmtTokens, shortModel } from './lib/utils';

const STATE_META: Record<string, { label: string; tone: BadgeTone; live?: boolean }> = {
  starting: { label: '启动中', tone: 'run', live: true },
  idle: { label: '空闲', tone: 'ok' },
  thinking: { label: '思考中', tone: 'run', live: true },
  waiting_input: { label: '等待输入', tone: 'human' },
  waiting_approval: { label: '等待审批', tone: 'human' },
  dead: { label: '已结束', tone: 'neutral' },
};

export const SESSION_TITLE_MAX_LENGTH = 120;

export function normalizeSessionTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 && title.length <= SESSION_TITLE_MAX_LENGTH ? title : null;
}

export function SessionTitleEditor({
  title,
  draft,
  editing,
  saving,
  onEdit,
  onDraftChange,
  onCancel,
  onSave,
}: {
  title: string;
  draft: string;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSave: (title: string) => void;
}) {
  const normalized = normalizeSessionTitle(draft);
  if (!editing) {
    return (
      <div className="group flex min-w-0 items-center gap-1">
        <div className="truncate text-[13px] font-medium text-ink" title={title}>{title}</div>
        <button
          type="button"
          aria-label="重命名会话"
          title="重命名会话"
          className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink group-hover:opacity-100 focus:opacity-100"
          onClick={onEdit}
        >
          <Pencil size={12} />
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (normalized) onSave(normalized);
      }}
    >
      <input
        autoFocus
        aria-label="会话标题"
        value={draft}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        disabled={saving}
        className="h-7 min-w-48 rounded-md border border-accent bg-bg-2 px-2 text-[13px] text-ink outline-none"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="保存会话标题" title="保存" disabled={!normalized || saving}>
        <Check size={13} />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="取消重命名" title="取消" disabled={saving} onClick={onCancel}>
        <X size={13} />
      </Button>
    </form>
  );
}

function CostBadge({ usage }: { usage: SessionUsage }) {
  return (
    <Badge tone="neutral" title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens} · ${usage.turns} 回合`}>
      {fmtCost(usage.costUsd)} · {fmtTokens(usage.inputTokens + usage.outputTokens)} tok
    </Badge>
  );
}

function DiffDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<{ stat?: string; diff?: string; error?: string } | null>(null);
  useEffect(() => {
    if (open) {
      setData(null);
      api.sessionDiff(sessionId).then(setData).catch((e) => setData({ error: String(e) }));
    }
  }, [open, sessionId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogTitle>工作目录变更（git diff）</DialogTitle>
        {!data ? (
          <div className="text-sm text-dim">加载中…</div>
        ) : data.error || !data.diff ? (
          <div className="text-sm text-dim">{data.error ?? '无变更'}</div>
        ) : (
          <>
            {data.stat && <pre className="mb-2 font-mono text-xs text-dim">{data.stat}</pre>}
            <UnifiedDiff diff={data.diff} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export async function downloadSessionArtifact(
  sessionId: string,
  path: string,
  request = api.workspaceFile,
  download: (blob: Blob, filename: string) => void = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },
): Promise<void> {
  const response = await request(sessionId, path);
  const encoded = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : path.split(/[\\/]/).pop() || 'artifact';
  download(await response.blob(), filename);
}

export async function downloadSessionDirectoryArchive(
  sessionId: string,
  path: string,
  request = api.workspaceArchive,
  download?: (blob: Blob, filename: string) => void,
): Promise<void> {
  await downloadSessionArtifact(sessionId, path, request, download);
}

export function workspaceChildPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

export function workspaceParentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export function workspaceSearchTarget(match: WorkspaceSearchMatch):
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; entry: WorkspaceEntry } {
  if (match.type === 'directory') return { kind: 'directory', path: match.path };
  return {
    kind: 'file',
    path: match.path,
    entry: { name: match.path.split('/').at(-1) ?? match.path, type: 'file', size: match.size },
  };
}

export function workspaceFileOpenMode(entry: WorkspaceEntry): 'text-preview' | 'image-preview' | 'download' {
  if (isWorkspaceTextPreviewCandidate(entry)) return 'text-preview';
  if (isWorkspaceImagePreviewCandidate(entry)) return 'image-preview';
  return 'download';
}

export const WORKSPACE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export async function saveWorkspaceTextFile(
  sessionId: string,
  path: string,
  text: string,
  request = api.uploadWorkspaceFile,
): Promise<void> {
  const contents = new Blob([text], { type: 'text/plain;charset=utf-8' });
  if (contents.size > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) {
    throw new Error(`文件超过 ${WORKSPACE_TEXT_PREVIEW_MAX_BYTES} 字节编辑上限`);
  }
  await request(sessionId, path, contents);
}

export async function uploadSelectedWorkspaceFile(
  sessionId: string,
  directory: string,
  file: File,
  request = api.uploadWorkspaceFile,
): Promise<string> {
  if (file.size > WORKSPACE_UPLOAD_MAX_BYTES) {
    throw new Error(`文件超过 ${WORKSPACE_UPLOAD_MAX_BYTES} 字节上限`);
  }
  const destination = workspaceChildPath(directory, file.name);
  await request(sessionId, destination, file);
  return destination;
}

export async function setWorkspaceFileExecutable(
  sessionId: string,
  path: string,
  executable: boolean,
  request = api.setWorkspaceFileExecutable,
): Promise<boolean> {
  const result = await request(sessionId, path, executable);
  return result.executable;
}

export function normalizeWorkspaceFolderName(value: string): string | null {
  const name = value.trim();
  return name && name !== '.' && name !== '..' && !/[\\/]/.test(name) ? name : null;
}

export const normalizeWorkspaceEntryName = normalizeWorkspaceFolderName;
export const normalizeWorkspaceFileName = normalizeWorkspaceFolderName;

export async function createNamedWorkspaceFile(
  sessionId: string,
  directory: string,
  value: string,
  entries: readonly WorkspaceEntry[],
  request = api.uploadWorkspaceFile,
): Promise<string> {
  const name = normalizeWorkspaceFileName(value);
  if (!name) throw new Error('文件名称不能为空，且不能包含路径分隔符');
  if (entries.some((entry) => entry.name === name)) throw new Error(`当前目录已存在 ${name}`);
  const destination = workspaceChildPath(directory, name);
  await request(sessionId, destination, new Blob([''], { type: 'text/plain;charset=utf-8' }));
  return destination;
}

export function WorkspaceCreateFileAction({
  disabled,
  creating,
  onCreate,
}: {
  disabled: boolean;
  creating: boolean;
  onCreate: () => void;
}) {
  return <Button type="button" variant="outline" size="sm" disabled={disabled || creating} onClick={onCreate}>
    <FilePlus size={13} /> {creating ? '创建中…' : '新建文件'}
  </Button>;
}

export async function renameNamedWorkspaceEntry(
  sessionId: string,
  path: string,
  value: string,
  request = api.renameWorkspaceEntry,
): Promise<string> {
  const name = normalizeWorkspaceEntryName(value);
  if (!name) throw new Error('新名称不能为空，且不能包含路径分隔符');
  const result = await request(sessionId, path, name);
  return result.path;
}

export function requestWorkspaceEntryName(
  entry: WorkspaceEntry,
  onRename: (entry: WorkspaceEntry, name: string) => void,
  ask: (message: string, initial: string) => string | null = (message, initial) => prompt(message, initial),
): void {
  const name = ask(`请输入 ${entry.name} 的新名称`, entry.name);
  if (name !== null) onRename(entry, name);
}

export function normalizeWorkspaceMoveDestination(value: string): string | null {
  const path = value.trim();
  const parts = path.split('/');
  return path && !path.startsWith('/') && !path.includes('\\') && parts.every((part) => part && part !== '.' && part !== '..')
    ? path
    : null;
}

export async function moveNamedWorkspaceEntry(
  sessionId: string,
  path: string,
  value: string,
  request = api.moveWorkspaceEntry,
): Promise<string> {
  const destinationPath = normalizeWorkspaceMoveDestination(value);
  if (!destinationPath) throw new Error('目标路径必须是工作区内的相对路径，且不能包含空段或 ..');
  const result = await request(sessionId, path, destinationPath);
  return result.path;
}

export function requestWorkspaceMoveDestination(
  entry: WorkspaceEntry,
  currentPath: string,
  onMove: (entry: WorkspaceEntry, destinationPath: string) => void,
  ask: (message: string, initial: string) => string | null = (message, initial) => prompt(message, initial),
): void {
  const sourcePath = workspaceChildPath(currentPath, entry.name);
  const destinationPath = ask(`请输入 ${entry.name} 的目标相对路径`, sourcePath);
  if (destinationPath !== null) onMove(entry, destinationPath);
}

export async function copyNamedWorkspaceEntry(
  sessionId: string,
  path: string,
  value: string,
  request = api.copyWorkspaceEntry,
): Promise<string> {
  const destinationPath = normalizeWorkspaceMoveDestination(value);
  if (!destinationPath) throw new Error('目标路径必须是工作区内的相对路径，且不能包含空段或 ..');
  const result = await request(sessionId, path, destinationPath);
  return result.path;
}

export function requestWorkspaceCopyDestination(
  entry: WorkspaceEntry,
  currentPath: string,
  onCopy: (entry: WorkspaceEntry, destinationPath: string) => void,
  ask: (message: string, initial: string) => string | null = (message, initial) => prompt(message, initial),
): void {
  const sourcePath = workspaceChildPath(currentPath, entry.name);
  const destinationPath = ask(`请输入 ${entry.name} 的副本相对路径`, `${sourcePath}-copy`);
  if (destinationPath !== null) onCopy(entry, destinationPath);
}

export async function createNamedWorkspaceFolder(
  sessionId: string,
  directory: string,
  value: string,
  request = api.createWorkspaceDirectory,
): Promise<string> {
  const name = normalizeWorkspaceFolderName(value);
  if (!name) throw new Error('文件夹名称不能为空，且不能包含路径分隔符');
  const destination = workspaceChildPath(directory, name);
  await request(sessionId, destination);
  return destination;
}

export function requestWorkspaceFolderName(
  onCreate: (name: string) => void,
  ask: () => string | null = () => prompt('请输入新文件夹名称'),
): void {
  const name = ask();
  if (name !== null) onCreate(name);
}

export function WorkspaceCreateFolderAction({
  disabled,
  creating,
  onCreate,
}: {
  disabled: boolean;
  creating: boolean;
  onCreate: (name: string) => void;
}) {
  return <Button
    type="button"
    variant="outline"
    size="sm"
    disabled={disabled || creating}
    onClick={() => requestWorkspaceFolderName(onCreate)}
  >
    <FolderPlus size={13} /> {creating ? '创建中…' : '新建文件夹'}
  </Button>;
}

export async function deleteConfirmedWorkspaceEntry(
  sessionId: string,
  path: string,
  type: WorkspaceEntry['type'],
  request = api.deleteWorkspaceFile,
  confirmDelete: (path: string, type: WorkspaceEntry['type']) => boolean = (target, targetType) => confirm(
    targetType === 'directory'
      ? `确定删除工作区文件夹 /${target} 及其中的所有内容？此操作无法撤销。`
      : `确定删除工作区文件 /${target}？此操作无法撤销。`,
  ),
): Promise<boolean> {
  if (!confirmDelete(path, type)) return false;
  await request(sessionId, path);
  return true;
}

export function WorkspaceUploadAction({
  disabled,
  uploading,
  onFile,
}: {
  disabled: boolean;
  uploading: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}>
      <Upload size={13} /> {uploading ? '上传中…' : '上传文件'}
    </Button>
    <input
      ref={inputRef}
      type="file"
      aria-label="选择要上传的文件"
      className="hidden"
      disabled={disabled || uploading}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) onFile(file);
      }}
    />
  </>;
}

export function WorkspaceBrowserEntries({
  path,
  entries,
  disabled,
  onDirectory,
  onFile,
  onDownloadDirectory,
  onDelete,
  onRename,
  onMove,
  onCopy,
  onExecutableChange,
}: {
  path: string;
  entries: WorkspaceEntry[];
  disabled: boolean;
  onDirectory: (name: string) => void;
  onFile: (entry: WorkspaceEntry) => void;
  onDownloadDirectory: (entry: WorkspaceEntry) => void;
  onDelete: (entry: WorkspaceEntry) => void;
  onRename: (entry: WorkspaceEntry, name: string) => void;
  onMove: (entry: WorkspaceEntry, destinationPath: string) => void;
  onCopy: (entry: WorkspaceEntry, destinationPath: string) => void;
  onExecutableChange: (entry: WorkspaceEntry, executable: boolean) => void;
}) {
  if (entries.length === 0) return <div className="py-8 text-center text-sm text-faint">此目录为空</div>;
  return (
    <div className="max-h-80 overflow-y-auto rounded-md border border-line">
      {entries.map((entry) => (
        <div
          key={`${entry.type}:${entry.name}`}
          className="flex w-full items-center border-b border-line text-sm text-ink last:border-b-0 hover:bg-panel-2"
        >
          <button
            type="button"
            disabled={disabled}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left disabled:opacity-50"
            onClick={() => entry.type === 'directory' ? onDirectory(entry.name) : onFile(entry)}
          >
            {entry.type === 'directory' ? <Folder size={15} className="text-accent" /> : <File size={15} className="text-dim" />}
            <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
            {entry.type === 'file' && entry.size !== undefined && <span className="text-xs text-faint">{entry.size.toLocaleString()} B</span>}
          </button>
          {entry.type === 'directory' && <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-dim"
            aria-label={`下载 ${entry.name}`}
            title="下载 .tar.gz"
            disabled={disabled}
            onClick={() => onDownloadDirectory(entry)}
          >
            <Download size={13} />
          </Button>}
          {entry.type === 'file' && <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={`shrink-0 ${entry.executable ? 'text-accent' : 'text-dim'}`}
            aria-label={`${entry.executable ? '移除' : '添加'} ${entry.name} 的可执行权限`}
            aria-pressed={entry.executable === true}
            title={entry.executable ? '移除可执行权限' : '设为可执行'}
            disabled={disabled}
            onClick={() => onExecutableChange(entry, !entry.executable)}
          >
            <Code2 size={13} />
          </Button>}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-dim"
            aria-label={`重命名 ${entry.name}`}
            disabled={disabled}
            onClick={() => requestWorkspaceEntryName(entry, onRename)}
          >
            <Pencil size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-dim"
            aria-label={`移动 ${entry.name}`}
            disabled={disabled}
            onClick={() => requestWorkspaceMoveDestination(entry, path, onMove)}
          >
            <FolderInput size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`复制 ${entry.name}`}
            title="复制"
            disabled={disabled}
            onClick={() => requestWorkspaceCopyDestination(entry, path, onCopy)}
          >
            <Copy size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0 text-danger"
            aria-label={`删除 ${entry.name}`}
            disabled={disabled}
            onClick={() => onDelete(entry)}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function WorkspaceSearchResults({
  matches,
  disabled,
  onSelect,
}: {
  matches: WorkspaceSearchMatch[];
  disabled: boolean;
  onSelect: (match: WorkspaceSearchMatch) => void;
}) {
  if (matches.length === 0) return <div className="py-8 text-center text-sm text-faint">未找到匹配的文件或文件夹</div>;
  return (
    <div className="max-h-80 overflow-y-auto rounded-md border border-line">
      {matches.map((match) => (
        <button
          key={`${match.type}:${match.path}`}
          type="button"
          disabled={disabled}
          className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm text-ink last:border-b-0 hover:bg-panel-2 disabled:opacity-50"
          onClick={() => onSelect(match)}
        >
          {match.type === 'directory' ? <Folder size={15} className="text-accent" /> : <File size={15} className="text-dim" />}
          <span className="min-w-0 flex-1 truncate font-mono">{match.path}</span>
          {match.type === 'file' && match.size !== undefined && <span className="text-xs text-faint">{match.size.toLocaleString()} B</span>}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceContentSearchResults({
  matches,
  disabled,
  onSelect,
}: {
  matches: WorkspaceContentMatch[];
  disabled: boolean;
  onSelect: (match: WorkspaceContentMatch) => void;
}) {
  if (matches.length === 0) return <div className="py-8 text-center text-sm text-faint">未找到匹配的文件内容</div>;
  return (
    <div className="max-h-80 overflow-y-auto rounded-md border border-line">
      {matches.map((match) => (
        <button
          key={`${match.path}:${match.line}`}
          type="button"
          disabled={disabled}
          className="block w-full border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-panel-2 disabled:opacity-50"
          onClick={() => onSelect(match)}
        >
          <span className="block truncate font-mono text-xs text-accent">{match.path}:{match.line}</span>
          <span className="block truncate font-mono text-sm text-ink">{match.preview}</span>
        </button>
      ))}
    </div>
  );
}

export function WorkspaceFilePreview({
  path,
  text,
  imageUrl,
  error,
  downloading,
  onBack,
  onDownload,
  editing = false,
  saving = false,
  draft = text ?? '',
  editable = text !== undefined && error === undefined,
  onEdit,
  onDraftChange,
  onCancel,
  onSave,
  line,
}: {
  path: string;
  text?: string;
  imageUrl?: string;
  error?: string;
  downloading: boolean;
  onBack: () => void;
  onDownload: () => void;
  editing?: boolean;
  saving?: boolean;
  draft?: string;
  editable?: boolean;
  onEdit?: () => void;
  onDraftChange?: (value: string) => void;
  onCancel?: () => void;
  onSave?: () => void;
  line?: number;
}) {
  const matchedLineRef = useRef<HTMLSpanElement>(null);
  const draftSize = new Blob([draft]).size;
  const draftOversized = draftSize > WORKSPACE_TEXT_PREVIEW_MAX_BYTES;
  useEffect(() => {
    if (line && text) matchedLineRef.current?.scrollIntoView({ block: 'center' });
  }, [line, text]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="返回目录列表" disabled={downloading || saving} onClick={onBack}>
          <ChevronLeft size={14} />
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-dim" title={path}>/{path}{line ? `:${line}` : ''}</div>
        {editable && !editing ? <Button type="button" variant="outline" size="sm" disabled={downloading || saving} onClick={onEdit}>
          <Pencil size={13} /> 编辑
        </Button> : null}
        {editing ? <>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>取消</Button>
          <Button type="button" variant="outline" size="sm" disabled={saving || draftOversized} onClick={onSave}>
            <Check size={13} /> {saving ? '保存中…' : '保存'}
          </Button>
        </> : null}
        <Button type="button" variant="outline" size="sm" disabled={downloading || saving} onClick={onDownload}>
          <Download size={13} /> {downloading ? '下载中…' : '下载'}
        </Button>
      </div>
      {editing
        ? <div className="space-y-1">
            <Textarea
              autoFocus
              aria-label="工作区文件内容"
              className="min-h-[50vh] resize-y font-mono text-xs leading-5"
              disabled={saving}
              value={draft}
              onChange={(event) => onDraftChange?.(event.currentTarget.value)}
            />
            <div className={draftOversized ? 'text-xs text-danger' : 'text-xs text-faint'}>
              {draftSize} / {WORKSPACE_TEXT_PREVIEW_MAX_BYTES} 字节
            </div>
          </div>
        : error
        ? <div className="rounded-md border border-line bg-panel-2 px-3 py-8 text-center text-sm text-dim">{error}</div>
        : imageUrl
          ? <div className="flex max-h-[60vh] justify-center overflow-auto rounded-md border border-line bg-bg-2 p-3">
              <img className="max-h-[55vh] max-w-full object-contain" src={imageUrl} alt={`工作区图片 ${path}`} />
            </div>
        : line && text
          ? <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg-2 p-3 font-mono text-xs leading-5 text-ink">
              {text.split(/\r?\n/).map((value, index) => {
                const number = index + 1;
                return <span key={number} ref={number === line ? matchedLineRef : undefined} className={number === line ? 'block bg-accent/15' : 'block'}>{value}{'\n'}</span>;
              })}
            </pre>
          : <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg-2 p-3 font-mono text-xs leading-5 text-ink">{text}</pre>}
    </div>
  );
}

export function replaceWorkspaceImageObjectUrl(currentUrl?: string, blob?: Blob): string | undefined {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  return blob ? URL.createObjectURL(blob) : undefined;
}

export function ArtifactDownloadDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [preview, setPreview] = useState<{ path: string; line?: number; text?: string; imageUrl?: string; error?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [editingPreview, setEditingPreview] = useState(false);
  const [previewDraft, setPreviewDraft] = useState('');
  const [savingPreview, setSavingPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [fileNameDraft, setFileNameDraft] = useState<string | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<WorkspaceSearchMatch[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [contentQuery, setContentQuery] = useState('');
  const [contentMatches, setContentMatches] = useState<WorkspaceContentMatch[] | null>(null);
  const [contentTruncated, setContentTruncated] = useState(false);
  const [contentSearching, setContentSearching] = useState(false);
  const [listingVersion, setListingVersion] = useState(0);
  const previewRequestRef = useRef(0);
  const imageObjectUrlRef = useRef<string | undefined>(undefined);
  const replaceImageObjectUrl = (blob?: Blob) => {
    const nextUrl = replaceWorkspaceImageObjectUrl(imageObjectUrlRef.current, blob);
    imageObjectUrlRef.current = nextUrl;
    return nextUrl;
  };
  useEffect(() => () => {
    replaceWorkspaceImageObjectUrl(imageObjectUrlRef.current);
    imageObjectUrlRef.current = undefined;
  }, []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.workspaceFiles(sessionId, path)
      .then((listing) => {
        if (cancelled) return;
        setEntries(listing.entries);
        setTruncated(listing.truncated);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, path, sessionId, listingVersion]);
  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPath('');
      setEntries([]);
      setError(null);
      replaceImageObjectUrl();
      setPreview(null);
      setEditingPreview(false);
      setPreviewDraft('');
      setFileNameDraft(null);
      setSearchQuery('');
      setSearchMatches(null);
      setSearchTruncated(false);
      setContentQuery('');
      setContentMatches(null);
      setContentTruncated(false);
      previewRequestRef.current += 1;
    }
    onOpenChange(nextOpen);
  };
  const downloadFile = (relativePath: string, closeAfter = true) => {
    if (downloading) return;
    setDownloading(true);
    void downloadSessionArtifact(sessionId, relativePath)
      .then(() => { toast.success('文件已下载'); if (closeAfter) close(false); })
      .catch((error) => toast.error(`下载失败：${error}`))
      .finally(() => setDownloading(false));
  };
  const downloadDirectory = (entry: WorkspaceEntry) => {
    if (downloading) return;
    setDownloading(true);
    const relativePath = workspaceChildPath(path, entry.name);
    void downloadSessionDirectoryArchive(sessionId, relativePath)
      .then(() => toast.success('文件夹归档已下载'))
      .catch((error) => toast.error(`下载失败：${error}`))
      .finally(() => setDownloading(false));
  };
  const openFile = (relativePath: string, entry: WorkspaceEntry, line?: number) => {
    const openMode = workspaceFileOpenMode(entry);
    if (openMode === 'download') {
      downloadFile(relativePath);
      return;
    }
    const requestId = ++previewRequestRef.current;
    replaceImageObjectUrl();
    setPreview({ path: relativePath, line });
    setEditingPreview(false);
    setPreviewDraft('');
    setPreviewing(true);
    const request = openMode === 'image-preview'
      ? api.workspaceImagePreview(sessionId, relativePath)
      : api.workspaceTextPreview(sessionId, relativePath);
    void request
      .then((result) => {
        if (previewRequestRef.current !== requestId) return;
        if (result.kind === 'image') setPreview({ path: relativePath, imageUrl: replaceImageObjectUrl(result.blob) });
        else if (result.kind === 'text') setPreview({ path: relativePath, line, text: result.text });
        else setPreview({ path: relativePath, line, error: result.kind === 'oversized' ? '文件过大，无法预览，请下载后查看。' : '文件不是可预览的 UTF-8 文本，请下载后查看。' });
      })
      .catch((error) => {
        if (previewRequestRef.current === requestId) setPreview({ path: relativePath, line, error: `预览加载失败：${error}` });
      })
      .finally(() => {
        if (previewRequestRef.current === requestId) setPreviewing(false);
      });
  };
  const selectFile = (entry: WorkspaceEntry) => openFile(workspaceChildPath(path, entry.name), entry);
  const savePreview = () => {
    if (!preview || savingPreview) return;
    const previewPath = preview.path;
    setSavingPreview(true);
    void saveWorkspaceTextFile(sessionId, previewPath, previewDraft)
      .then(() => api.workspaceTextPreview(sessionId, previewPath))
      .then((result) => {
        if (result.kind !== 'text') throw new Error('保存后的文件无法作为 UTF-8 文本读取');
        setPreview({ path: previewPath, text: result.text });
        setPreviewDraft(result.text);
        setEditingPreview(false);
        toast.success('文件已保存');
      })
      .catch((error) => toast.error(`保存失败：${error}`))
      .finally(() => setSavingPreview(false));
  };
  const searchWorkspace = () => {
    const query = searchQuery.trim();
    if (!query || searching) return;
    setSearching(true);
    setError(null);
    void api.searchWorkspaceFiles(sessionId, query)
      .then((result) => { setSearchMatches(result.matches); setSearchTruncated(result.truncated); setContentMatches(null); })
      .catch((err) => setError(String(err)))
      .finally(() => setSearching(false));
  };
  const selectSearchMatch = (match: WorkspaceSearchMatch) => {
    const target = workspaceSearchTarget(match);
    if (target.kind === 'directory') {
      setPath(target.path);
      setSearchQuery('');
      setSearchMatches(null);
      setSearchTruncated(false);
      return;
    }
    openFile(target.path, target.entry);
  };
  const searchWorkspaceContent = () => {
    const query = contentQuery.trim();
    if (!query || contentSearching) return;
    setContentSearching(true);
    setError(null);
    void api.searchWorkspaceContent(sessionId, query)
      .then((result) => { setContentMatches(result.matches); setContentTruncated(result.truncated); setSearchMatches(null); })
      .catch((err) => setError(String(err)))
      .finally(() => setContentSearching(false));
  };
  const selectContentMatch = (match: WorkspaceContentMatch) => {
    openFile(match.path, { name: match.path.split('/').at(-1) ?? match.path, type: 'file', size: 0 }, match.line);
  };
  const uploadFile = (file: File) => {
    if (uploading) return;
    setUploading(true);
    void uploadSelectedWorkspaceFile(sessionId, path, file)
      .then(() => { toast.success('文件已上传'); setListingVersion((version) => version + 1); })
      .catch((error) => toast.error(`上传失败：${error}`))
      .finally(() => setUploading(false));
  };
  const createFolder = (name: string) => {
    if (creating) return;
    setCreating(true);
    void createNamedWorkspaceFolder(sessionId, path, name)
      .then(() => { toast.success('文件夹已创建'); setListingVersion((version) => version + 1); })
      .catch((error) => toast.error(`创建失败：${error}`))
      .finally(() => setCreating(false));
  };
  const normalizedFileName = fileNameDraft === null ? null : normalizeWorkspaceFileName(fileNameDraft);
  const fileNameConflict = normalizedFileName !== null && entries.some((entry) => entry.name === normalizedFileName);
  const createFile = () => {
    if (creatingFile || fileNameDraft === null) return;
    setCreatingFile(true);
    void createNamedWorkspaceFile(sessionId, path, fileNameDraft, entries)
      .then((destination) => {
        toast.success('文件已创建');
        setListingVersion((version) => version + 1);
        setFileNameDraft(null);
        setPreview({ path: destination, text: '' });
        setPreviewDraft('');
        setEditingPreview(true);
      })
      .catch((error) => toast.error(`创建失败：${error}`))
      .finally(() => setCreatingFile(false));
  };
  const deleteEntry = (entry: WorkspaceEntry) => {
    if (deleting) return;
    const relativePath = workspaceChildPath(path, entry.name);
    setDeleting(true);
    void deleteConfirmedWorkspaceEntry(sessionId, relativePath, entry.type)
      .then((deleted) => {
        if (!deleted) return;
        toast.success(entry.type === 'directory' ? '文件夹已删除' : '文件已删除');
        setListingVersion((version) => version + 1);
      })
      .catch((error) => toast.error(`删除失败：${error}`))
      .finally(() => setDeleting(false));
  };
  const renameEntry = (entry: WorkspaceEntry, name: string) => {
    if (renaming) return;
    const relativePath = workspaceChildPath(path, entry.name);
    setRenaming(true);
    void renameNamedWorkspaceEntry(sessionId, relativePath, name)
      .then(() => { toast.success('名称已更新'); setListingVersion((version) => version + 1); })
      .catch((error) => toast.error(`重命名失败：${error}`))
      .finally(() => setRenaming(false));
  };
  const moveEntry = (entry: WorkspaceEntry, destinationPath: string) => {
    if (moving) return;
    const relativePath = workspaceChildPath(path, entry.name);
    setMoving(true);
    void moveNamedWorkspaceEntry(sessionId, relativePath, destinationPath)
      .then(() => { toast.success('条目已移动'); setListingVersion((version) => version + 1); })
      .catch((error) => toast.error(`移动失败：${error}`))
      .finally(() => setMoving(false));
  };
  const copyEntry = (entry: WorkspaceEntry, destinationPath: string) => {
    if (copying) return;
    const relativePath = workspaceChildPath(path, entry.name);
    setCopying(true);
    void copyNamedWorkspaceEntry(sessionId, relativePath, destinationPath)
      .then(() => { toast.success('条目已复制'); setListingVersion((version) => version + 1); })
      .catch((error) => toast.error(`复制失败：${error}`))
      .finally(() => setCopying(false));
  };
  const changeExecutable = (entry: WorkspaceEntry, executable: boolean) => {
    if (changingMode || entry.type !== 'file') return;
    const relativePath = workspaceChildPath(path, entry.name);
    setChangingMode(true);
    void setWorkspaceFileExecutable(sessionId, relativePath, executable)
      .then((persisted) => {
        toast.success(persisted ? '文件已设为可执行' : '文件可执行权限已移除');
        setListingVersion((version) => version + 1);
      })
      .catch((error) => toast.error(`权限更新失败：${error}`))
      .finally(() => setChangingMode(false));
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogTitle>浏览工作区文件</DialogTitle>
        {preview ? <WorkspaceFilePreview
          path={preview.path}
          text={previewing ? '加载中…' : preview.text}
          imageUrl={previewing ? undefined : preview.imageUrl}
          error={previewing ? undefined : preview.error}
          downloading={downloading}
          editing={editingPreview}
          saving={savingPreview}
          draft={previewDraft}
          editable={!previewing && preview.text !== undefined && preview.error === undefined}
          onEdit={() => { setPreviewDraft(preview.text ?? ''); setEditingPreview(true); }}
          onDraftChange={setPreviewDraft}
          onCancel={() => { setPreviewDraft(preview.text ?? ''); setEditingPreview(false); }}
          onSave={savePreview}
          onBack={() => { previewRequestRef.current += 1; replaceImageObjectUrl(); setPreviewing(false); setEditingPreview(false); setPreview(null); }}
          onDownload={() => downloadFile(preview.path, false)}
          line={preview.line}
        /> : <div className="space-y-3">
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); searchWorkspace(); }}>
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type="search"
                aria-label="按文件名搜索工作区"
                maxLength={100}
                value={searchQuery}
                className="h-8 w-full rounded-md border border-line bg-bg-2 pl-8 pr-2 text-sm text-ink outline-none focus:border-accent"
                placeholder="递归搜索文件名"
                onChange={(event) => {
                  setSearchQuery(event.currentTarget.value);
                  if (!event.currentTarget.value.trim()) { setSearchMatches(null); setSearchTruncated(false); }
                }}
              />
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={!searchQuery.trim() || searching || downloading}>
              {searching ? '搜索中…' : '搜索'}
            </Button>
          </form>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); searchWorkspaceContent(); }}>
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type="search"
                aria-label="搜索工作区文件内容"
                maxLength={100}
                value={contentQuery}
                className="h-8 w-full rounded-md border border-line bg-bg-2 pl-8 pr-2 text-sm text-ink outline-none focus:border-accent"
                placeholder="搜索文件内容"
                onChange={(event) => {
                  setContentQuery(event.currentTarget.value);
                  if (!event.currentTarget.value.trim()) { setContentMatches(null); setContentTruncated(false); }
                }}
              />
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={!contentQuery.trim() || contentSearching || downloading}>
              {contentSearching ? '搜索中…' : '搜索内容'}
            </Button>
          </form>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="返回上级目录" disabled={!path || loading || downloading || uploading || creating || creatingFile || fileNameDraft !== null || deleting || renaming || moving || copying || changingMode} onClick={() => setPath(workspaceParentPath(path))}>
              <ChevronLeft size={14} />
            </Button>
            <div className="min-w-0 flex-1 truncate font-mono text-xs text-dim" title={path || '/'}>/{path}</div>
            <WorkspaceCreateFileAction disabled={loading || downloading || uploading || creating || fileNameDraft !== null || deleting || renaming || moving || copying || changingMode} creating={creatingFile} onCreate={() => setFileNameDraft('')} />
            <WorkspaceCreateFolderAction disabled={loading || downloading || uploading || creatingFile || fileNameDraft !== null || deleting || renaming || moving || copying || changingMode} creating={creating} onCreate={createFolder} />
            <WorkspaceUploadAction disabled={loading || downloading || creating || creatingFile || fileNameDraft !== null || deleting || renaming || moving || copying || changingMode} uploading={uploading} onFile={uploadFile} />
          </div>
          {fileNameDraft !== null ? <form
            className="flex items-start gap-2 rounded-md border border-line bg-panel-2 p-2"
            onSubmit={(event) => { event.preventDefault(); createFile(); }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                autoFocus
                aria-label="新文件名称"
                placeholder="例如 notes.md"
                value={fileNameDraft}
                disabled={creatingFile}
                onChange={(event) => setFileNameDraft(event.currentTarget.value)}
              />
              {fileNameDraft && !normalizedFileName ? <div className="text-xs text-danger">文件名称不能是 . 或 ..，且不能包含路径分隔符。</div> : null}
              {fileNameConflict ? <div className="text-xs text-danger">当前目录已存在同名文件或文件夹。</div> : null}
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={creatingFile} onClick={() => setFileNameDraft(null)}>取消</Button>
            <Button type="submit" variant="outline" size="sm" disabled={!normalizedFileName || fileNameConflict || creatingFile}>
              <Check size={13} /> {creatingFile ? '保存中…' : '保存并编辑'}
            </Button>
          </form> : null}
          {contentMatches !== null
            ? <WorkspaceContentSearchResults matches={contentMatches} disabled={downloading || contentSearching} onSelect={selectContentMatch} />
            : searchMatches !== null
            ? <WorkspaceSearchResults matches={searchMatches} disabled={downloading || searching} onSelect={selectSearchMatch} />
            : loading ? <div className="py-8 text-center text-sm text-dim">加载中…</div>
            : error ? <div className="py-8 text-center text-sm text-danger">目录加载失败：{error}</div>
            : <WorkspaceBrowserEntries
                path={path}
                entries={entries}
                disabled={downloading || uploading || creating || creatingFile || fileNameDraft !== null || deleting || renaming || moving || copying || changingMode}
                onDirectory={(name) => setPath(workspaceChildPath(path, name))}
                onFile={selectFile}
                onDownloadDirectory={downloadDirectory}
                onDelete={deleteEntry}
                onRename={renameEntry}
                onMove={moveEntry}
                onCopy={copyEntry}
                onExecutableChange={changeExecutable}
              />}
          {searchMatches !== null && searchTruncated && <div className="text-xs text-faint">仅显示前 100 个匹配结果，请缩小搜索范围。</div>}
          {contentMatches !== null && contentTruncated && <div className="text-xs text-faint">仅显示前 100 个内容匹配，请缩小搜索范围。</div>}
          {searchMatches === null && truncated && !loading && !error && <div className="text-xs text-faint">仅显示前 200 项，请进入子目录继续浏览。</div>}
          <div className="text-xs text-faint">可按文件名或文件内容递归搜索并直接打开结果；也可新建文本文件或文件夹，切换文件可执行权限，重命名、移动、复制或删除当前目录中的文件和文件夹，或上传文件。文件夹可下载为 .tar.gz 归档；支持的 UTF-8 文本及 PNG、JPEG、GIF、WebP 图片可在线预览，其他文件可下载。单个文件或归档上限 10 MiB。</div>
        </div>}
      </DialogContent>
    </Dialog>
  );
}

export function isSessionResumable(session: SessionRow, state: string, runnerOnline: boolean): boolean {
  return (
    state === 'dead' &&
    runnerOnline &&
    session.archivedAt == null &&
    session.runId == null &&
    session.containerId == null &&
    Boolean(session.nativeSessionId) &&
    (session.agent === 'claude' || session.agent === 'codex')
  );
}

export function ResumeAction({
  visible,
  resuming,
  onResume,
}: {
  visible: boolean;
  resuming: boolean;
  onResume: () => void;
}) {
  if (!visible) return null;
  return (
    <Button variant="success" size="sm" disabled={resuming} onClick={onResume}>
      <RotateCcw size={12} /> {resuming ? '恢复中…' : '恢复会话'}
    </Button>
  );
}

export function isSessionForkable(session: SessionRow, state: string, runnerOnline: boolean): boolean {
  return (
    (state === 'idle' || state === 'dead') &&
    runnerOnline &&
    session.archivedAt == null &&
    session.runId == null &&
    session.containerId == null &&
    Boolean(session.nativeSessionId) &&
    (session.agent === 'claude' || session.agent === 'codex')
  );
}

export function ForkAction({
  visible,
  forking,
  onFork,
}: {
  visible: boolean;
  forking: boolean;
  onFork: () => void;
}) {
  if (!visible) return null;
  return (
    <Button variant="secondary" size="sm" disabled={forking} onClick={onFork}>
      <GitFork size={12} /> {forking ? '分叉中…' : '分叉会话'}
    </Button>
  );
}

export type SessionArchiveMode = 'archive' | 'restore';

export function sessionArchiveMode(session: SessionRow, state: string): SessionArchiveMode | null {
  if (session.archivedAt != null) return 'restore';
  return state === 'dead' && session.runId == null ? 'archive' : null;
}

export function SessionArchiveAction({
  mode,
  updating,
  onChange,
}: {
  mode: SessionArchiveMode | null;
  updating: boolean;
  onChange: () => void;
}) {
  if (!mode) return null;
  const restoring = mode === 'restore';
  return (
    <Button variant="secondary" size="sm" disabled={updating} onClick={onChange}>
      {restoring ? <ArchiveRestore size={12} /> : <Archive size={12} />}
      {updating ? (restoring ? '移出中…' : '归档中…') : (restoring ? '移出归档' : '归档')}
    </Button>
  );
}

export function LoadEarlierAction({
  visible,
  loading,
  onLoad,
}: {
  visible: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="flex justify-center px-4 py-3">
      <Button variant="ghost" size="sm" disabled={loading} onClick={onLoad}>
        <ArrowUp size={12} /> {loading ? '加载中…' : '加载更早消息'}
      </Button>
    </div>
  );
}

export function TranscriptExportAction({
  exporting,
  onExport,
}: {
  exporting: boolean;
  onExport: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" disabled={exporting} onClick={onExport}>
      <Download size={13} /> {exporting ? '导出中…' : '导出记录'}
    </Button>
  );
}

export interface SessionNoteActionDependencies {
  request(sessionId: string, markdown: string): Promise<{ note: SessionNoteEventRow }>;
  success(message: string): void;
  error(message: string): void;
}

export async function sessionNoteAction(
  sessionId: string,
  markdown: string,
  deps: SessionNoteActionDependencies,
): Promise<SessionNoteEventRow> {
  try {
    const { note } = await deps.request(sessionId, markdown);
    deps.success('会话备注已添加');
    return note;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`添加会话备注失败：${detail}`);
    throw err;
  }
}

export function SessionNoteComposer({
  value,
  saving,
  onChange,
  onSubmit,
}: {
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const empty = value.trim().length === 0;
  return (
    <div className="flex gap-2">
      <Textarea
        aria-label="会话备注"
        value={value}
        rows={2}
        maxLength={SESSION_NOTE_MAX_LENGTH}
        placeholder="添加 Markdown 会话备注（不会发送给 Agent）"
        disabled={saving}
        className="resize-none"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !empty && !saving) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <Button variant="outline" size="sm" className="h-auto shrink-0" disabled={saving || empty} onClick={onSubmit}>
        <NotebookPen size={13} /> {saving ? '保存中…' : '添加备注'}
      </Button>
    </div>
  );
}

export function SessionView({ session, onForked }: { session: SessionRow; onForked?: (sessionId: string) => void }) {
  const { events, hasEarlier, loadingEarlier, loadEarlier } = useSessionEvents(session.id);
  const { data: machines = [] } = useMachines();
  const [text, setText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const fallbackTitle = session.cwd.split('/').pop() || session.cwd;
  const [displayTitle, setDisplayTitle] = useState(session.title ?? fallbackTitle);
  const [titleDraft, setTitleDraft] = useState(displayTitle);
  const [editingTitle, setEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showArtifactDownload, setShowArtifactDownload] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [forking, setForking] = useState(false);
  const [updatingArchive, setUpdatingArchive] = useState(false);
  const [exportingTranscript, setExportingTranscript] = useState(false);
  const resumeAfterSeqRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const NEAR_BOTTOM = 80;
  const machine = machines.find((item) => item.id === session.machineId) ?? null;

  useEffect(() => {
    const title = session.title ?? fallbackTitle;
    setDisplayTitle(title);
    setTitleDraft(title);
  }, [fallbackTitle, session.title]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    atBottomRef.current = near;
    if (near) setShowJump(false);
  };

  const { state, usage } = useMemo(() => {
    let st = session.state;
    let us: SessionUsage | null = session.usage;
    for (const row of events) {
      if (row.type === 'session.state') {
        const p = row.payload as { state: string; usage?: SessionUsage };
        st = p.state;
        if (p.usage) {
          us = p.usage;
        }
      }
    }
    return { state: st, usage: us };
  }, [events, session.state, session.usage]);

  const approvals = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    for (const row of events) {
      if (row.type === 'approval.requested') {
        const req = row.payload as ApprovalRequest;
        map.set(req.id, { request: req, status: 'pending' });
      } else if (row.type === 'approval.decided') {
        const p = row.payload as { approvalId: string; status: 'approved' | 'denied' };
        const ex = map.get(p.approvalId);
        if (ex) {
          map.set(p.approvalId, { ...ex, status: p.status });
        }
      }
    }
    return map;
  }, [events]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prependScroll = prependScrollRef.current;
    if (prependScroll) {
      el.scrollTop = prependScroll.top + el.scrollHeight - prependScroll.height;
      prependScrollRef.current = null;
      return;
    }
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [events.length]);

  const dead = state === 'dead';
  const busy = state === 'thinking' || state === 'starting';
  const meta = STATE_META[state] ?? { label: state, tone: 'neutral' as BadgeTone };
  const pendingApprovals = useMemo(
    () => [...approvals.values()].filter((item) => item.status === 'pending' && !isCodexUserInputRequest(item.request)),
    [approvals],
  );

  useEffect(() => {
    if (!resuming) return;
    const runnerStateArrived = events.some(
      (event) => event.type === 'session.state' && event.seq > resumeAfterSeqRef.current,
    );
    if (runnerStateArrived) setResuming(false);
  }, [events, resuming]);

  const handleApprovalError = (error: unknown) => {
    // 已被处理（其他端/自动决策）：降级为提示，等增量轮询把 decided 事件补回来
    if (String(error).includes('already')) toast.info('该请求已被处理，状态稍后同步');
    else toast.error(String(error));
  };

  const decide: ApprovalDecisionHandler = (id, behavior, message) => {
    void api.decide(id, behavior, message).catch(handleApprovalError);
  };

  const answer = (id: string, answers: UserInputAnswers) => api.answer(id, answers).catch(handleApprovalError);

  const doLoadEarlier = () => {
    const el = scrollRef.current;
    if (el) prependScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadEarlier()
      .then((page) => {
        if (!page || page.events.length === 0) prependScrollRef.current = null;
      })
      .catch((error) => {
        prependScrollRef.current = null;
        toast.error(`加载更早消息失败：${error}`);
      });
  };

  const doSend = () => {
    const t = text.trim();
    if (!t || dead || resuming || forking) {
      return;
    }
    setText('');
    api.send(session.id, t).catch((e) => toast.error(`发送失败：${e}`));
  };

  const doAddNote = () => {
    const markdown = noteText.trim();
    if (!markdown || addingNote) return;
    setAddingNote(true);
    void sessionNoteAction(session.id, markdown, {
      request: api.addSessionNote,
      success: toast.success,
      error: toast.error,
    })
      .then(() => setNoteText(''))
      .catch(() => {})
      .finally(() => setAddingNote(false));
  };

  const doResume = () => {
    resumeAfterSeqRef.current = events.reduce((max, event) => Math.max(max, event.seq), 0);
    setResuming(true);
    api.resume(session.id)
      .then(() => toast('正在恢复原会话…'))
      .catch((e) => {
        setResuming(false);
        toast.error(`恢复失败：${e}`);
      });
  };

  const doFork = () => {
    if (!onForked) return;
    setForking(true);
    api.fork(session.id)
      .then(({ sessionId }) => {
        invalidate('sessions');
        toast('已创建独立分叉会话');
        onForked(sessionId);
      })
      .catch((e) => toast.error(`分叉失败：${e}`))
      .finally(() => setForking(false));
  };

  const doRename = (title: string) => {
    setSavingTitle(true);
    api.renameSession(session.id, title)
      .then(() => {
        setDisplayTitle(title);
        setTitleDraft(title);
        setEditingTitle(false);
        invalidate('sessions');
        invalidate('archived-sessions');
        invalidate('session');
        toast('会话标题已更新');
      })
      .catch((error) => toast.error(`重命名失败：${error}`))
      .finally(() => setSavingTitle(false));
  };

  const archiveMode = sessionArchiveMode(session, state);
  const doExportTranscript = () => {
    if (exportingTranscript) return;
    setExportingTranscript(true);
    void exportSessionTranscript(session, api.events)
      .then(() => toast('会话记录已导出'))
      .catch((error) => toast.error(`导出会话记录失败：${error}`))
      .finally(() => setExportingTranscript(false));
  };

  const doChangeArchive = () => {
    if (!archiveMode) return;
    setUpdatingArchive(true);
    const request = archiveMode === 'archive' ? api.archiveSession(session.id) : api.restoreSession(session.id);
    request
      .then(() => {
        invalidate('sessions');
        invalidate('archived-sessions');
        invalidate('session');
        toast(archiveMode === 'archive' ? '会话已归档' : '会话已移回历史');
      })
      .catch((error) => toast.error(`${archiveMode === 'archive' ? '归档' : '恢复'}失败：${error}`))
      .finally(() => setUpdatingArchive(false));
  };

  const resumable = isSessionResumable(session, state, machine?.id === session.machineId);
  const forkable = Boolean(onForked) && isSessionForkable(session, state, machine?.id === session.machineId);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={meta.tone} live={meta.live} />
          <div className="min-w-0">
            <SessionTitleEditor
              title={displayTitle}
              draft={titleDraft}
              editing={editingTitle}
              saving={savingTitle}
              onEdit={() => {
                setTitleDraft(displayTitle);
                setEditingTitle(true);
              }}
              onDraftChange={setTitleDraft}
              onCancel={() => {
                setTitleDraft(displayTitle);
                setEditingTitle(false);
              }}
              onSave={doRename}
            />
            <div className="mono-nums truncate text-[11px] text-faint" title={session.cwd}>
              {session.cwd} · {session.machineId} · <span className="text-accent/70" title={shortModel(session.model).full}>{shortModel(session.model).display}</span> · {session.id.slice(0, 8)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {usage && usage.turns > 0 && <CostBadge usage={usage} />}
          {machine?.codeServerUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`${machine.codeServerUrl}/?folder=${encodeURIComponent(session.cwd)}`, '_blank')}
            >
              <Code2 size={13} /> 编辑器
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setShowDiff(true)}>
            <GitCompare size={13} /> 变更
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowArtifactDownload(true)}>
            <Download size={13} /> 文件
          </Button>
          <TranscriptExportAction exporting={exportingTranscript} onExport={doExportTranscript} />
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <SessionArchiveAction mode={archiveMode} updating={updatingArchive} onChange={doChangeArchive} />
          <ForkAction visible={forkable} forking={forking} onFork={doFork} />
          <ResumeAction visible={resumable} resuming={resuming} onResume={doResume} />
          {busy && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => api.interrupt(session.id).then(() => toast('已打断')).catch((e) => toast.error(String(e)))}
            >
              <Square size={12} /> 打断
            </Button>
          )}
          {!dead && (
            <Button variant="danger" size="sm" onClick={() => void api.kill(session.id).catch((e) => toast.error(String(e)))}>
              <X size={13} /> 终止
            </Button>
          )}
        </div>
      </header>
      <ArtifactDownloadDialog sessionId={session.id} open={showArtifactDownload} onOpenChange={setShowArtifactDownload} />

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <LoadEarlierAction visible={hasEarlier} loading={loadingEarlier} onLoad={doLoadEarlier} />
          <Timeline
            events={events}
            approvals={approvals}
            cwd={session.cwd}
            onDecide={decide}
            onAnswer={answer}
            onEditNote={(noteId, markdown) => api.editSessionNote(session.id, noteId, markdown)
              .then(() => { toast.success('会话备注已更新'); })
              .catch((e) => { toast.error(`更新会话备注失败：${e}`); throw e; })}
            onDeleteNote={(noteId) => api.deleteSessionNote(session.id, noteId)
              .then(() => { toast.success('会话备注已删除'); })
              .catch((e) => { toast.error(`删除会话备注失败：${e}`); throw e; })}
          />
          <div ref={bottomRef} />
        </div>
        {showJump && (
          <button
            onClick={() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); atBottomRef.current = true; setShowJump(false); }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink shadow-lg hover:bg-bg-2"
          >
            <ArrowDown size={12} /> 新消息
          </button>
        )}
      </div>

      {pendingApprovals.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-warn/30 bg-warn/5 px-4 py-2">
          {pendingApprovals.map(({ request }) => {
            const payload = request.payload as Record<string, unknown>;
            const input = (payload.input ?? payload) as Record<string, unknown>;
            const preview =
              typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ')
              : typeof input.file_path === 'string' ? input.file_path
              : '';
            return (
              <div key={request.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">待审批</Badge>
                <span className="shrink-0 text-xs font-medium text-ink">{request.title}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim" title={preview}>{preview}</span>
                <Button variant="success" size="sm" onClick={() => void decide(request.id, 'allow')}>批准</Button>
                <RejectionFeedback approvalId={request.id} onDecide={decide} />
              </div>
            );
          })}
        </div>
      )}

      <footer className="flex flex-col gap-2 border-t border-line bg-bg-2/40 px-4 py-3 backdrop-blur-sm">
        <SessionNoteComposer value={noteText} saving={addingNote} onChange={setNoteText} onSubmit={doAddNote} />
        <div className="flex gap-2">
          <Textarea
            value={text}
            rows={2}
            placeholder={forking ? '正在创建分叉会话…' : resuming ? '正在恢复原会话…' : dead ? '会话已结束' : '输入消息，Enter 发送，Shift+Enter 换行'}
            disabled={dead || resuming || forking}
            className="resize-none"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
          />
          <Button variant="default" size="icon" className="h-auto w-11 shrink-0" disabled={dead || resuming || forking || !text.trim()} onClick={doSend}>
            <Send size={15} />
          </Button>
        </div>
      </footer>

      <DiffDialog sessionId={session.id} open={showDiff} onOpenChange={setShowDiff} />
    </div>
  );
}
