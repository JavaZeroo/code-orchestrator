import { Archive, ArchiveRestore, ArrowLeft, Check, Download, ExternalLink, Pause, Pencil, Play, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { capabilityLoopStateSchema } from '@co/protocol';
import { api, type ApprovalRow, type ForgeRefRow, type NodeStateRow, type RunNoteEventRow, type RunRerunResult, type RunRetryResult, type RunRow, type WorkflowDefRow } from './api';
import { FlowGraph } from './FlowGraph';
import { RunTimeline } from './RunTimeline';
import { Markdown } from './components/Markdown';
import { CapabilityOutcomePanel } from './components/CapabilityOutcomePanel';
import { RejectionFeedback, type ApprovalDecisionHandler } from './components/RejectionFeedback';
import { Button } from './components/ui/button';
import { Badge, StatusDot, type BadgeTone } from './components/ui/primitives';
import { invalidate } from './lib/queries';
import { normalizeRunTitle, RUN_TITLE_MAX_LENGTH, runDisplayTitle } from './lib/runTitle';
import { exportRunTranscript } from './lib/transcript';
import { useRunEvents } from './useEvents';

const RUN_META: Record<string, { label: string; tone: BadgeTone; live?: boolean }> = {
  running: { label: '运行中', tone: 'run', live: true },
  waiting_human: { label: '等待审批', tone: 'human' },
  paused: { label: '已暂停', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const NODE_TONE: Record<string, BadgeTone> = {
  running: 'run',
  waiting_human: 'human',
  done: 'ok',
  failed: 'danger',
  pending: 'neutral',
  skipped: 'neutral',
};

export function RunTitleEditor({
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
  const normalized = normalizeRunTitle(draft);
  if (!editing) {
    return (
      <div className="group flex min-w-0 items-center gap-1">
        <div className="truncate font-display text-[14px] font-semibold text-ink" title={title}>{title}</div>
        <button
          type="button"
          aria-label="重命名运行"
          title="重命名运行"
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
        aria-label="运行标题"
        value={draft}
        maxLength={RUN_TITLE_MAX_LENGTH}
        disabled={saving}
        className="h-7 min-w-48 rounded-md border border-accent bg-bg-2 px-2 text-[13px] text-ink outline-none"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="保存运行标题" title="保存" disabled={!normalized || saving}>
        <Check size={13} />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="取消重命名" title="取消" disabled={saving} onClick={onCancel}>
        <X size={13} />
      </Button>
    </form>
  );
}

export interface RunRetestActionDependencies {
  request(refId: string): Promise<{ ok: true; confirmation: 'pending' }>;
  success(message: string): void;
  error(message: string): void;
  refresh(): void;
}

export async function runRetestAction(refId: string, deps: RunRetestActionDependencies): Promise<void> {
  try {
    await deps.request(refId);
    deps.success('已发送 /retest，等待 CI 状态确认');
    deps.refresh();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`CI 重跑失败：${detail}`);
    throw err;
  }
}

export interface RunForgeCommentActionDependencies {
  request(refId: string, body: string): Promise<{ ok: true; commentId: number }>;
  success(message: string): void;
  error(message: string): void;
}

export async function runForgeCommentAction(refId: string, body: string, deps: RunForgeCommentActionDependencies): Promise<void> {
  try {
    await deps.request(refId, body);
    deps.success('PR 评论已发布');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`PR 评论发布失败：${detail}`);
    throw err;
  }
}

export interface RunNoteActionDependencies {
  request(runId: string, markdown: string): Promise<{ note: RunNoteEventRow }>;
  success(message: string): void;
  error(message: string): void;
}

export async function runNoteAction(
  runId: string,
  markdown: string,
  deps: RunNoteActionDependencies,
): Promise<RunNoteEventRow> {
  try {
    const { note } = await deps.request(runId, markdown);
    deps.success('运行备注已添加');
    return note;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`添加运行备注失败：${detail}`);
    throw err;
  }
}

export interface RunRetryActionDependencies {
  request(runId: string): Promise<RunRetryResult>;
  success(message: string): void;
  error(message: string): void;
  refresh(result: RunRetryResult): void;
}

export function isRunRetryEligible(run: Pick<RunRow, 'status' | 'archivedAt'> | null): boolean {
  return run?.status === 'failed' && run.archivedAt === null;
}

export async function runRetryAction(
  runId: string,
  deps: RunRetryActionDependencies,
): Promise<RunRetryResult> {
  try {
    const result = await deps.request(runId);
    deps.success('运行已重新开始');
    deps.refresh(result);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`运行重试失败：${detail}`);
    throw err;
  }
}

export function RunRetryAction({
  eligible,
  retrying,
  onRetry,
}: {
  eligible: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!eligible) return null;
  return (
    <Button variant="secondary" size="sm" disabled={retrying} onClick={onRetry}>
      <RefreshCw size={12} className={retrying ? 'animate-spin' : undefined} />
      {retrying ? '重试中…' : '重试'}
    </Button>
  );
}

export interface RunRerunActionDependencies {
  request(runId: string): Promise<RunRerunResult>;
  success(message: string): void;
  error(message: string): void;
  open(runId: string): void;
}

export function isRunRerunEligible(run: Pick<RunRow, 'status'> | null): boolean {
  return run !== null && ['done', 'failed', 'cancelled'].includes(run.status);
}

export async function runRerunAction(
  runId: string,
  deps: RunRerunActionDependencies,
): Promise<RunRerunResult> {
  try {
    const result = await deps.request(runId);
    deps.success('已启动新的工作流运行');
    deps.open(result.runId);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`再次运行失败：${detail}`);
    throw err;
  }
}

export function RunRerunAction({
  eligible,
  rerunning,
  onRerun,
}: {
  eligible: boolean;
  rerunning: boolean;
  onRerun: () => void;
}) {
  if (!eligible) return null;
  return (
    <Button variant="secondary" size="sm" disabled={rerunning} onClick={onRerun}>
      <Play size={12} />
      {rerunning ? '启动中…' : '再次运行'}
    </Button>
  );
}

export type RunProgressionMode = 'pause' | 'resume';

export function runProgressionMode(run: Pick<RunRow, 'status'> | null): RunProgressionMode | null {
  if (run?.status === 'running' || run?.status === 'waiting_human') return 'pause';
  return run?.status === 'paused' ? 'resume' : null;
}

export function RunProgressionAction({
  mode,
  updating,
  onChange,
}: {
  mode: RunProgressionMode | null;
  updating: boolean;
  onChange: () => void;
}) {
  if (!mode) return null;
  const resuming = mode === 'resume';
  return (
    <Button variant={resuming ? 'success' : 'secondary'} size="sm" disabled={updating} onClick={onChange}>
      {resuming ? <Play size={12} /> : <Pause size={12} />}
      {updating ? (resuming ? '恢复中…' : '暂停中…') : (resuming ? '恢复' : '暂停')}
    </Button>
  );
}

export type RunArchiveMode = 'archive' | 'restore';

export function runArchiveMode(run: Pick<RunRow, 'status' | 'archivedAt'> | null): RunArchiveMode | null {
  if (!run) return null;
  if (run.archivedAt != null) return 'restore';
  return ['done', 'failed', 'cancelled'].includes(run.status) ? 'archive' : null;
}

export function RunArchiveAction({
  mode,
  updating,
  onChange,
}: {
  mode: RunArchiveMode | null;
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

export function RunTranscriptExportAction({
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

export function RunView({
  runId,
  onOpenSession,
  onOpenRun,
  onBack,
}: {
  runId: string;
  onOpenSession: (id: string) => void;
  onOpenRun: (id: string) => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<'thread' | 'graph'>('thread');
  const [retrying, setRetrying] = useState(false);
  const [fanoutAction, setFanoutAction] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [updatingProgression, setUpdatingProgression] = useState(false);
  const [updatingArchive, setUpdatingArchive] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const [exportingTranscript, setExportingTranscript] = useState(false);
  const [addingNote, setAddingNote] = useState(false);

  // ---- 共享数据（graph 模式用）----
  const [run, setRun] = useState<RunRow | null>(null);
  const [def, setDef] = useState<WorkflowDefRow | null>(null);
  const [nodes, setNodes] = useState<NodeStateRow[]>([]);
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  // graph 模式 refresh
  const refreshGraph = useCallback(() => {
    api.run(runId).then((d) => {
      setRun(d.run);
      setDef(d.def);
      setNodes(d.nodes);
    }).catch((e) => toast.error(String(e)));
    api.pendingApprovals().then(setPending).catch(() => {});
  }, [runId]);

  // graph 模式轮询 + WS
  useEffect(() => {
    if (mode !== 'graph') return;
    refreshGraph();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?runId=${runId}`);
    ws.onmessage = () => refreshGraph();
    const timer = setInterval(refreshGraph, 5_000);
    return () => {
      ws.close();
      clearInterval(timer);
    };
  }, [runId, mode, refreshGraph]);

  // ---- thread 模式数据 ----
  const [threadRun, setThreadRun] = useState<RunRow | null>(null);
  const [threadDef, setThreadDef] = useState<WorkflowDefRow | null>(null);
  const [threadNodes, setThreadNodes] = useState<NodeStateRow[]>([]);
  const [threadForgeRefs, setThreadForgeRefs] = useState<ForgeRefRow[]>([]);

  const {
    events: threadEvents,
    hasEarlier: threadHasEarlier,
    loadingEarlier: threadLoadingEarlier,
    loadEarlier: loadEarlierThreadEvents,
  } = useRunEvents(runId);

  // thread 模式 refresh：重新拉 run/def/nodes/forgeRefs（轻量查询，仿 graph 模式 5s 轮询）
  const refreshThread = useCallback(() => {
    api.runThread(runId).then((d) => {
      setThreadRun(d.run);
      setThreadDef(d.def);
      setThreadNodes(d.nodes);
      setThreadForgeRefs(d.forgeRefs);
    }).catch((e) => toast.error(String(e)));
  }, [runId]);

  // 首次挂载 + 切模式时拉取
  useEffect(() => {
    if (mode !== 'thread') return;
    refreshThread();
  }, [runId, mode, refreshThread]);

  // WS 事件到达时重新拉取（debounce 1s，合并短时间内的连续事件）
  const threadDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (mode !== 'thread' || threadEvents.length === 0) return;
    clearTimeout(threadDebounceRef.current);
    threadDebounceRef.current = setTimeout(refreshThread, 1_000);
    return () => clearTimeout(threadDebounceRef.current);
  }, [threadEvents.length, mode, refreshThread]);

  // 每 5s 兜底轮询（cover 无 WS 事件但状态已变的情况，如 runner 离线/网络瞬断）
  useEffect(() => {
    if (mode !== 'thread') return;
    const timer = setInterval(refreshThread, 5_000);
    return () => clearInterval(timer);
  }, [mode, refreshThread]);

  // 当前活跃节点会话（用于插话）
  const activeSessionId = useMemo(() => {
    const allNodes = mode === 'thread' ? threadNodes : nodes;
    const running = allNodes
      .filter((n) => n.status === 'running' && n.sessionId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return running[0]?.sessionId ?? null;
  }, [mode, threadNodes, nodes]);

  // 使用 thread 数据或 graph 数据（取决于 mode）
  const effectiveRun = mode === 'thread' ? threadRun : run;
  const effectiveDef = mode === 'thread' ? threadDef : def;
  const effectiveNodes = mode === 'thread' ? threadNodes : nodes;

  // graph 模式派生
  const statuses = useMemo(() => Object.fromEntries(nodes.map((n) => [n.nodeId, n.status])), [nodes]);
  const selState = nodes.find((n) => n.nodeId === selected);
  const capabilityStateResult = capabilityLoopStateSchema.safeParse(selState?.output);
  const capabilityState = capabilityStateResult.success ? capabilityStateResult.data : null;
  const selNode = def?.graph.nodes.find((n) => n.id === selected);
  // def 标题里的 {{vars.x}} 模板用本 run 变量插值（thread 视图在 RunTimeline 内处理）
  const interpTitle = useCallback((t?: string) => {
    const vars = (run ?? threadRun)?.context?.vars ?? {};
    return t?.replace(/\{\{vars\.([\w.]+)\}\}/g, (_, k: string) => vars[k] ?? '');
  }, [run, threadRun]);
  const interpGraph = useMemo(() => {
    if (!def) return null;
    return { ...def.graph, nodes: def.graph.nodes.map((n) => ({ ...n, title: interpTitle(n.title) })) };
  }, [def, interpTitle]);
  const gate = pending.find((a) => a.kind === 'gate' && a.runId === runId && a.nodeId === selected);
  const runMeta = RUN_META[effectiveRun?.status ?? ''] ?? { label: effectiveRun?.status ?? '', tone: 'neutral' as const };
  const retryEligible = isRunRetryEligible(effectiveRun);
  const rerunEligible = isRunRerunEligible(effectiveRun);
  const progressionMode = runProgressionMode(effectiveRun);
  const archiveMode = runArchiveMode(effectiveRun);
  const effectiveTitle = effectiveRun
    ? runDisplayTitle(effectiveRun, effectiveDef?.name)
    : effectiveDef?.name ?? runId;

  // 共享的 decide 处理
  const handleDecide: ApprovalDecisionHandler = useCallback((id, behavior, message) => {
    api.decide(id, behavior, message)
      .then(() => {
        if (mode === 'graph') refreshGraph();
        else refreshThread();
      })
      .catch((e) => {
        if (String(e).includes('already')) toast.info('该审批已被处理，状态稍后同步');
        else toast.error(String(e));
      });
  }, [mode, refreshGraph, refreshThread]);

  // 共享的 send 处理
  const handleSend = useCallback((text: string) => {
    const sid = activeSessionId;
    if (!sid) return;
    api.send(sid, text).catch((e) => toast.error(`发送失败：${e}`));
  }, [activeSessionId]);

  const handleAddNote = useCallback(async (markdown: string) => {
    setAddingNote(true);
    try {
      await runNoteAction(runId, markdown, {
        request: api.addRunNote,
        success: toast.success,
        error: toast.error,
      });
    } finally {
      setAddingNote(false);
    }
  }, [runId]);

  const handleEditNote = useCallback(async (noteId: number, markdown: string) => {
    try {
      await api.editRunNote(runId, noteId, markdown);
      toast.success('运行备注已更新');
    } catch (error) {
      toast.error(`更新运行备注失败：${error}`);
      throw error;
    }
  }, [runId]);

  const handleDeleteNote = useCallback(async (noteId: number) => {
    try {
      await api.deleteRunNote(runId, noteId);
      toast.success('运行备注已删除');
    } catch (error) {
      toast.error(`删除运行备注失败：${error}`);
      throw error;
    }
  }, [runId]);

  const handleRetest = useCallback((refId: string) => runRetestAction(refId, {
    request: api.retestForgeRef,
    success: toast.success,
    error: toast.error,
    refresh: refreshThread,
  }), [refreshThread]);

  const handleForgeComment = useCallback((refId: string, body: string) => runForgeCommentAction(refId, body, {
    request: api.commentForgeRef,
    success: toast.success,
    error: toast.error,
  }), []);

  const handleRetry = useCallback(() => {
    if (!retryEligible || retrying) return;
    setRetrying(true);
    void runRetryAction(runId, {
      request: api.retryRun,
      success: toast.success,
      error: toast.error,
      refresh: ({ run: changed }) => {
        const applyRetryState = (current: RunRow | null) => current
          ? { ...current, status: changed.status, endedAt: changed.endedAt }
          : null;
        setRun(applyRetryState);
        setThreadRun(applyRetryState);
        invalidate('runs');
        refreshThread();
        refreshGraph();
      },
    })
      .catch(() => {})
      .finally(() => setRetrying(false));
  }, [refreshGraph, refreshThread, retryEligible, retrying, runId]);

  const handleFanoutAction = useCallback(async (
    nodeId: string,
    index: number,
    action: 'retry' | 'cancel',
  ) => {
    const key = `${nodeId}:${index}:${action}`;
    if (fanoutAction) return;
    setFanoutAction(key);
    try {
      if (action === 'retry') await api.retryFanoutChild(runId, nodeId, index);
      else await api.cancelFanoutChild(runId, nodeId, index);
      toast.success(action === 'retry' ? `子任务 #${index + 1} 已重新排队` : `子任务 #${index + 1} 已取消`);
      refreshGraph();
      refreshThread();
    } catch (error) {
      toast.error(`${action === 'retry' ? '重试' : '取消'}子任务失败：${error}`);
    } finally {
      setFanoutAction(null);
    }
  }, [fanoutAction, refreshGraph, refreshThread, runId]);

  const handleRerun = useCallback(() => {
    if (!rerunEligible || rerunning) return;
    setRerunning(true);
    void runRerunAction(runId, {
      request: api.rerunRun,
      success: toast.success,
      error: toast.error,
      open: (newRunId) => {
        invalidate('runs');
        onOpenRun(newRunId);
      },
    })
      .catch(() => {})
      .finally(() => setRerunning(false));
  }, [onOpenRun, rerunEligible, rerunning, runId]);

  const handleArchiveChange = useCallback(() => {
    if (!archiveMode) return;
    setUpdatingArchive(true);
    const request = archiveMode === 'archive' ? api.archiveRun(runId) : api.restoreRun(runId);
    request
      .then(({ run: changed }) => {
        const applyArchiveState = (current: RunRow | null) => current ? { ...current, archivedAt: changed.archivedAt } : null;
        setRun(applyArchiveState);
        setThreadRun(applyArchiveState);
        invalidate('runs');
        invalidate('archived-runs');
        toast(archiveMode === 'archive' ? '运行已归档' : '运行已移回历史');
      })
      .catch((error) => toast.error(`${archiveMode === 'archive' ? '归档' : '恢复'}失败：${error}`))
      .finally(() => setUpdatingArchive(false));
  }, [archiveMode, runId]);

  const handleProgressionChange = useCallback(() => {
    if (!progressionMode || updatingProgression) return;
    setUpdatingProgression(true);
    const request = progressionMode === 'pause' ? api.pauseRun(runId) : api.resumeRun(runId);
    request
      .then(({ run: changed }) => {
        const applyProgressionState = (current: RunRow | null) => current
          ? { ...current, status: changed.status }
          : null;
        setRun(applyProgressionState);
        setThreadRun(applyProgressionState);
        invalidate('runs');
        toast.success(progressionMode === 'pause' ? '运行已暂停；进行中的节点会继续完成' : '运行已恢复');
      })
      .catch((error) => toast.error(`${progressionMode === 'pause' ? '暂停' : '恢复'}失败：${error}`))
      .finally(() => setUpdatingProgression(false));
  }, [progressionMode, runId, updatingProgression]);

  const handleRename = useCallback((title: string) => {
    setSavingTitle(true);
    api.renameRun(runId, title)
      .then(({ run: changed }) => {
        const applyTitle = (current: RunRow | null) => current ? { ...current, title: changed.title } : null;
        setRun(applyTitle);
        setThreadRun(applyTitle);
        setTitleDraft(changed.title ?? title);
        setEditingTitle(false);
        invalidate('runs');
        invalidate('archived-runs');
        toast('运行标题已更新');
      })
      .catch((error) => toast.error(`重命名失败：${error}`))
      .finally(() => setSavingTitle(false));
  }, [runId]);

  const handleExportTranscript = useCallback(() => {
    if (exportingTranscript) return;
    setExportingTranscript(true);
    void exportRunTranscript(runId, api.runThread)
      .then(() => toast('运行记录已导出'))
      .catch((error) => toast.error(`导出运行记录失败：${error}`))
      .finally(() => setExportingTranscript(false));
  }, [exportingTranscript, runId]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> 返回
          </Button>
          <RunTitleEditor
            title={effectiveTitle}
            draft={titleDraft}
            editing={editingTitle}
            saving={savingTitle}
            onEdit={() => {
              setTitleDraft(effectiveTitle);
              setEditingTitle(true);
            }}
            onDraftChange={setTitleDraft}
            onCancel={() => {
              setTitleDraft(effectiveTitle);
              setEditingTitle(false);
            }}
            onSave={handleRename}
          />
          <span className="mono-nums text-[11px] text-faint">run {runId.slice(0, 8)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 视图切换 */}
          <div className="flex rounded-lg border border-line bg-panel-2 p-0.5">
            <button
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'thread' ? 'bg-bg text-ink shadow-sm' : 'text-dim hover:text-ink'}`}
              onClick={() => setMode('thread')}
            >
              对话
            </button>
            <button
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'graph' ? 'bg-bg text-ink shadow-sm' : 'text-dim hover:text-ink'}`}
              onClick={() => setMode('graph')}
            >
              编排图
            </button>
          </div>
          <RunTranscriptExportAction exporting={exportingTranscript} onExport={handleExportTranscript} />
          <StatusDot tone={runMeta.tone} live={runMeta.live} />
          <Badge tone={runMeta.tone}>{runMeta.label}</Badge>
          <RunProgressionAction mode={progressionMode} updating={updatingProgression} onChange={handleProgressionChange} />
          <RunRetryAction eligible={retryEligible} retrying={retrying} onRetry={handleRetry} />
          <RunRerunAction eligible={rerunEligible} rerunning={rerunning} onRerun={handleRerun} />
          <RunArchiveAction mode={archiveMode} updating={updatingArchive} onChange={handleArchiveChange} />
          {(effectiveRun?.status === 'running' || effectiveRun?.status === 'waiting_human' || effectiveRun?.status === 'paused') && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!confirm('取消该 run？活跃节点会话将被终止。')) return;
                api.cancelRun(runId)
                  .then(() => { toast.success('已取消'); refreshThread(); refreshGraph(); })
                  .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
              }}
            >
              取消
            </Button>
          )}
        </div>
      </header>

      {mode === 'thread' && threadDef ? (
        <RunTimeline
          events={threadEvents}
          nodes={threadNodes}
          def={threadDef}
          run={threadRun!}
          forgeRefs={threadForgeRefs}
          activeSessionId={activeSessionId}
          onSend={handleSend}
          onAddNote={handleAddNote}
          onEditNote={handleEditNote}
          onDeleteNote={handleDeleteNote}
          addingNote={addingNote}
          onDecide={handleDecide}
          onRetest={handleRetest}
          onComment={handleForgeComment}
          hasEarlier={threadHasEarlier}
          loadingEarlier={threadLoadingEarlier}
          onLoadEarlier={loadEarlierThreadEvents}
          onOpenSession={onOpenSession}
        />
      ) : mode === 'graph' ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="min-h-72 flex-1">
            {def && <FlowGraph def={interpGraph ?? def.graph} statuses={statuses} onNodeClick={setSelected} />}
          </div>
          {selected && selNode && (
            <div className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-bg-2/40 p-4 backdrop-blur-sm">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display font-semibold text-ink">{interpTitle(selNode.title) ?? selNode.id}</h3>
                <span className="text-[11px] text-faint">({selNode.type})</span>
                {selState?.model && <span className="mono-nums rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-accent/80">{selState.model}</span>}
                {selState && <Badge tone={NODE_TONE[selState.status] ?? 'neutral'}>{selState.status}</Badge>}
              </div>
              {selNode.type === 'agent' && (
                <div>
                  <div className="mb-1 text-[11px] font-medium tracking-wide text-dim uppercase">prompt</div>
                  <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-xs whitespace-pre-wrap text-ink-2">
                    {selNode.prompt}
                  </pre>
                </div>
              )}
              {capabilityState && <CapabilityOutcomePanel state={capabilityState} />}
              {selNode.type === 'condition' && typeof selState?.output?.result === 'boolean' && (
                <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
                  条件结果：<Badge tone={selState.output.result ? 'ok' : 'warn'}>{selState.output.result ? '是' : '否'}</Badge>
                  <div className="mt-2 text-xs text-dim">
                    进入 {(selState.output.selected ?? []).join(', ') || '空分支'}
                    {(selState.output.skipped?.length ?? 0) > 0 && `；跳过 ${selState.output.skipped!.join(', ')}`}
                  </div>
                </div>
              )}
              {selNode.type === 'fanout' && selState?.output?.children && (
                <div>
                  <div className="mb-1 text-[11px] font-medium tracking-wide text-dim uppercase">
                    并行子任务 · {selState.output.children.filter((child) => child.status === 'done').length}/{selState.output.children.length}
                  </div>
                  <div className="mb-2 text-[11px] text-dim">
                    活跃 {selState.output.children.filter((child) => child.status === 'queued' || child.status === 'running').length}
                    /{selState.output.maxConcurrency ?? 4} · {selState.output.failFast ? '失败即停止' : '失败后继续其余任务'}
                  </div>
                  <div className="space-y-2">
                    {selState.output.children.map((child) => (
                      <div key={child.index} className="rounded-lg border border-line bg-panel-2 p-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">#{child.index + 1}</span>
                          <Badge tone={NODE_TONE[child.status] ?? 'neutral'}>{child.status}</Badge>
                          {(child.attempt ?? 1) > 1 && <span className="text-faint">第 {child.attempt} 次</span>}
                          {child.sessionId && (
                            <button className="ml-auto text-accent hover:underline" onClick={() => onOpenSession(child.sessionId!)}>打开会话</button>
                          )}
                        </div>
                        <div className="mt-1 truncate text-dim">{typeof child.item === 'string' ? child.item : JSON.stringify(child.item)}</div>
                        {child.error && <div className="mt-1 text-danger">{child.error}</div>}
                        {(child.history?.length ?? 0) > 0 && (
                          <details className="mt-2 text-faint">
                            <summary className="cursor-pointer">历史尝试 {child.history!.length} 次</summary>
                            <div className="mt-1 space-y-1 border-l border-line pl-2">
                              {child.history!.map((attempt) => (
                                <div key={attempt.attempt}>
                                  <span>第 {attempt.attempt} 次 · {attempt.status}</span>
                                  {attempt.sessionId && (
                                    <button className="ml-2 text-accent hover:underline" onClick={() => onOpenSession(attempt.sessionId!)}>
                                      打开会话
                                    </button>
                                  )}
                                  {attempt.error && <div className="truncate text-danger">{attempt.error}</div>}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        <div className="mt-2 flex gap-1">
                          {(child.status === 'failed' || child.status === 'cancelled') && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={fanoutAction !== null}
                              onClick={() => void handleFanoutAction(selNode.id, child.index, 'retry')}
                            >
                              <RefreshCw size={11} className={fanoutAction === `${selNode.id}:${child.index}:retry` ? 'animate-spin' : undefined} />
                              重试
                            </Button>
                          )}
                          {(child.status === 'pending' || child.status === 'queued' || child.status === 'running') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={fanoutAction !== null}
                              onClick={() => void handleFanoutAction(selNode.id, child.index, 'cancel')}
                            >
                              <X size={11} /> 取消
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selNode.type === 'meeting' && selState?.output?.sessions && selState.output.sessions.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-medium tracking-wide text-dim uppercase">评审会话</div>
                  <div className="space-y-2">
                    {selState.output.sessions.map((session) => (
                      <div key={session.sessionId} className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 p-2 text-xs">
                        <span>{session.idx === 'arbiter' ? '仲裁人' : `参与者 ${session.idx + 1}`}</span>
                        <Badge tone={NODE_TONE[session.status] ?? 'neutral'}>{session.status}</Badge>
                        <button className="ml-auto text-accent hover:underline" onClick={() => onOpenSession(session.sessionId)}>打开会话</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selState?.output?.verdict && (
                <Badge tone={selState.output.verdict === 'approve' ? 'ok' : 'danger'}>裁决：{selState.output.verdict}</Badge>
              )}
              {selState?.output?.summary && (
                <div>
                  <div className="mb-1 text-xs text-dim">输出摘要</div>
                  <div className="rounded-md border border-line bg-panel-2 p-2 text-sm">
                    <Markdown text={selState.output.summary} />
                  </div>
                </div>
              )}
              {selState?.output?.minutes && (
                <div>
                  <div className="mb-1 text-xs text-dim">会议纪要</div>
                  <div className="rounded-md border border-line bg-panel-2 p-2 text-sm">
                    <Markdown text={selState.output.minutes} />
                  </div>
                </div>
              )}
              {selState?.output?.error && (
                <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{selState.output.error}</div>
              )}
              {selState?.sessionId && (
                <Button variant="secondary" size="sm" className="self-start" onClick={() => onOpenSession(selState.sessionId!)}>
                  <ExternalLink size={13} /> 打开会话
                </Button>
              )}
              {gate && selState?.status === 'waiting_human' && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="success" size="sm" onClick={() => handleDecide(gate.id, 'allow')}>
                    批准通过
                  </Button>
                  <RejectionFeedback approvalId={gate.id} onDecide={handleDecide} />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-dim">加载中…</div>
      )}
    </div>
  );
}
