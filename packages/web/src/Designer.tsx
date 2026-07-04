import { useEffect, useMemo, useState } from 'react';
import { api, type MachineRow, type SessionRow, type WorkflowDef } from './api';
import { FlowGraph } from './FlowGraph';
import { SessionView } from './SessionView';
import { useSessionEvents } from './useEvents';

function DraftPane({ sessionId, onSaved }: { sessionId: string; onSaved: (id: string) => void }) {
  const events = useSessionEvents(sessionId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'workflow.draft') {
        return events[i]!.payload as WorkflowDef;
      }
    }
    return null;
  }, [events]);

  const save = () => {
    if (!draft) {
      return;
    }
    setSaving(true);
    api
      .createWorkflow(draft, 'chat')
      .then((d) => onSaved(d.id))
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="draft-pane">
      <header>
        <b>工作流草图</b>
        <button disabled={!draft || saving} onClick={save}>
          {saving ? '保存中…' : '保存为工作流'}
        </button>
      </header>
      {error && <div className="error">{error}</div>}
      {draft ? (
        <>
          <div className="dim" style={{ padding: '4px 12px' }}>
            {draft.name} · {draft.nodes.length} 节点
          </div>
          <div className="flow-wrap">
            <FlowGraph def={draft} />
          </div>
        </>
      ) : (
        <div className="dim" style={{ padding: 24 }}>
          在左侧描述你要的流程，agent 会调用 emit_workflow 生成草图，实时渲染在这里。
        </div>
      )}
    </div>
  );
}

export function Designer({ onSaved, onBack }: { onSaved: (workflowId: string) => void; onBack: () => void }) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .machines()
      .then((machines: MachineRow[]) => {
        const machine = machines[0];
        if (!machine) {
          throw new Error('没有在线机器，无法启动设计会话');
        }
        return api.spawn({ machineId: machine.id, cwd: '/root', designer: true });
      })
      .then(({ sessionId }) => api.sessions().then((all) => all.find((s) => s.id === sessionId) ?? null))
      .then((row) => {
        if (!cancelled) {
          setSession(row);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="designer">
      <header>
        <button onClick={onBack}>← 返回</button> <b>对话式搭建工作流</b>
        <span className="dim">描述流程 → 实时出图 → 确认保存</span>
      </header>
      {error && <div className="error">{error}</div>}
      {session ? (
        <div className="designer-split">
          <div className="designer-chat">
            <SessionView session={session} />
          </div>
          <DraftPane sessionId={session.id} onSaved={onSaved} />
        </div>
      ) : (
        !error && <div className="dim" style={{ padding: 24 }}>正在启动设计会话…</div>
      )}
    </div>
  );
}
