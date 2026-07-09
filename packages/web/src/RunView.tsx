import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type ApprovalRow, type ForgeRefRow, type NodeStateRow, type RunRow, type WorkflowDefRow } from './api';
import { FlowGraph } from './FlowGraph';
import { RunTimeline } from './RunTimeline';
import { Markdown } from './components/Markdown';
import { Button } from './components/ui/button';
import { Badge, StatusDot, type BadgeTone } from './components/ui/primitives';
import { useRunEvents } from './useEvents';

const RUN_META: Record<string, { label: string; tone: BadgeTone; live?: boolean }> = {
  running: { label: '运行中', tone: 'run', live: true },
  waiting_human: { label: '等待审批', tone: 'human' },
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

export function RunView({ runId, onOpenSession, onBack }: { runId: string; onOpenSession: (id: string) => void; onBack: () => void }) {
  const [mode, setMode] = useState<'thread' | 'graph'>('thread');

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

  const threadEvents = useRunEvents(runId);

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

  // 共享的 decide 处理
  const handleDecide = useCallback((id: string, b: 'allow' | 'deny') => {
    api.decide(id, b)
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

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> 返回
          </Button>
          <span className="truncate font-display text-[14px] font-semibold text-ink">{effectiveDef?.name ?? runId}</span>
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
          <StatusDot tone={runMeta.tone} live={runMeta.live} />
          <Badge tone={runMeta.tone}>{runMeta.label}</Badge>
          {(effectiveRun?.status === 'running' || effectiveRun?.status === 'waiting_human') && (
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
          onDecide={handleDecide}
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
                <div className="flex gap-2">
                  <Button variant="success" size="sm" onClick={() => handleDecide(gate.id, 'allow')}>
                    批准通过
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => handleDecide(gate.id, 'deny')}>
                    拒绝
                  </Button>
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
