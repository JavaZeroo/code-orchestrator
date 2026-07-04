import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type ApprovalRow, type NodeStateRow, type RunRow, type WorkflowDefRow } from './api';
import { FlowGraph } from './FlowGraph';
import { Markdown } from './components/Markdown';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/primitives';

const RUN_META: Record<string, { label: string; tone: 'accent' | 'warn' | 'ok' | 'danger' | 'neutral' }> = {
  running: { label: '运行中', tone: 'accent' },
  waiting_human: { label: '等待审批', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const NODE_TONE: Record<string, 'accent' | 'warn' | 'ok' | 'danger' | 'neutral'> = {
  running: 'accent',
  waiting_human: 'warn',
  done: 'ok',
  failed: 'danger',
  pending: 'neutral',
  skipped: 'neutral',
};

export function RunView({ runId, onOpenSession, onBack }: { runId: string; onOpenSession: (id: string) => void; onBack: () => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [def, setDef] = useState<WorkflowDefRow | null>(null);
  const [nodes, setNodes] = useState<NodeStateRow[]>([]);
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.run(runId).then((d) => {
      setRun(d.run);
      setDef(d.def);
      setNodes(d.nodes);
    }).catch((e) => toast.error(String(e)));
    api.pendingApprovals().then(setPending).catch(() => {});
  }, [runId]);

  useEffect(() => {
    refresh();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?runId=${runId}`);
    ws.onmessage = () => refresh();
    const timer = setInterval(refresh, 5_000);
    return () => {
      ws.close();
      clearInterval(timer);
    };
  }, [runId, refresh]);

  const statuses = useMemo(() => Object.fromEntries(nodes.map((n) => [n.nodeId, n.status])), [nodes]);
  const selState = nodes.find((n) => n.nodeId === selected);
  const selNode = def?.graph.nodes.find((n) => n.id === selected);
  const gate = pending.find((a) => a.kind === 'gate' && a.runId === runId && a.nodeId === selected);
  const runMeta = RUN_META[run?.status ?? ''] ?? { label: run?.status ?? '', tone: 'neutral' as const };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> 返回
          </Button>
          <b>{def?.name ?? runId}</b>
          <span className="text-xs text-dim">run {runId.slice(0, 8)}</span>
        </div>
        <Badge tone={runMeta.tone}>{runMeta.label}</Badge>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="min-h-72 flex-1">
          {def && <FlowGraph def={def.graph} statuses={statuses} onNodeClick={setSelected} />}
        </div>
        {selected && selNode && (
          <div className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{selNode.title ?? selNode.id}</h3>
              <span className="text-xs text-dim">({selNode.type})</span>
              {selState && <Badge tone={NODE_TONE[selState.status] ?? 'neutral'}>{selState.status}</Badge>}
            </div>
            {selNode.type === 'agent' && (
              <div>
                <div className="mb-1 text-xs text-dim">prompt</div>
                <pre className="max-h-40 overflow-auto rounded-md border border-line bg-[#0d1117] p-2 font-mono text-xs whitespace-pre-wrap">
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
                <Button variant="success" size="sm" onClick={() => api.decide(gate.id, 'allow').then(refresh).catch((e) => toast.error(String(e)))}>
                  批准通过
                </Button>
                <Button variant="danger" size="sm" onClick={() => api.decide(gate.id, 'deny').then(refresh).catch((e) => toast.error(String(e)))}>
                  拒绝
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
