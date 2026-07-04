import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ApprovalRow, type NodeStateRow, type RunRow, type WorkflowDefRow } from './api';
import { FlowGraph } from './FlowGraph';

const RUN_LABEL: Record<string, string> = {
  running: '运行中',
  waiting_human: '等待审批',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

interface Props {
  runId: string;
  onOpenSession: (sessionId: string) => void;
  onBack: () => void;
}

export function RunView({ runId, onOpenSession, onBack }: Props) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [def, setDef] = useState<WorkflowDefRow | null>(null);
  const [nodes, setNodes] = useState<NodeStateRow[]>([]);
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .run(runId)
      .then((d) => {
        setRun(d.run);
        setDef(d.def);
        setNodes(d.nodes);
      })
      .catch((e) => setError(String(e)));
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
  const selectedState = nodes.find((n) => n.nodeId === selected);
  const selectedNode = def?.graph.nodes.find((n) => n.id === selected);
  const gateApproval = pending.find((a) => a.kind === 'gate' && a.runId === runId && a.nodeId === selected);

  const decide = (behavior: 'allow' | 'deny') => {
    if (!gateApproval) {
      return;
    }
    api
      .decide(gateApproval.id, behavior)
      .then(refresh)
      .catch((e) => setError(String(e)));
  };

  return (
    <div className="run-view">
      <header>
        <div>
          <button onClick={onBack}>← 返回</button> <b>{def?.name ?? runId}</b>
          <span className="dim"> run {runId.slice(0, 8)}</span>
        </div>
        <span className={`chip run-${run?.status}`}>{RUN_LABEL[run?.status ?? ''] ?? run?.status}</span>
      </header>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="run-body">
        <div className="flow-wrap">{def && <FlowGraph def={def.graph} statuses={statuses} onNodeClick={setSelected} />}</div>
        {selected && selectedNode && (
          <div className="node-panel">
            <h3>
              {selectedNode.title ?? selectedNode.id} <span className="dim">({selectedNode.type})</span>
            </h3>
            <p>
              状态：<span className={`chip run-${selectedState?.status}`}>{selectedState?.status}</span>
            </p>
            {selectedNode.type === 'agent' && (
              <>
                <div className="dim">prompt</div>
                <pre>{selectedNode.prompt}</pre>
              </>
            )}
            {selectedState?.output?.verdict && (
              <p>
                裁决：
                <span className={`chip ${selectedState.output.verdict === 'approve' ? 'approved' : 'denied'}`}>
                  {selectedState.output.verdict}
                </span>
              </p>
            )}
            {selectedState?.output?.summary && (
              <>
                <div className="dim">输出摘要</div>
                <pre>{selectedState.output.summary}</pre>
              </>
            )}
            {selectedState?.output?.minutes && (
              <>
                <div className="dim">会议纪要</div>
                <pre>{selectedState.output.minutes}</pre>
              </>
            )}
            {selectedState?.output?.error && <pre className="error">{selectedState.output.error}</pre>}
            {selectedState?.sessionId && (
              <button onClick={() => onOpenSession(selectedState.sessionId!)}>打开会话 ↗</button>
            )}
            {gateApproval && selectedState?.status === 'waiting_human' && (
              <div className="approval-actions" style={{ marginTop: 8 }}>
                <button className="allow" onClick={() => decide('allow')}>
                  批准通过
                </button>
                <button className="deny" onClick={() => decide('deny')}>
                  拒绝
                </button>
              </div>
            )}
            <button className="dim-btn" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
