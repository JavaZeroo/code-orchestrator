import { ArrowLeft, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type MachineRow, type SessionRow, type WorkflowDef } from './api';
import { FlowGraph } from './FlowGraph';
import { SessionView } from './SessionView';
import { Button } from './components/ui/button';
import { Spinner } from './components/ui/primitives';
import { useProjectScope } from './lib/project';
import { useSessionEvents } from './useEvents';

function DraftPane({ sessionId, onSaved }: { sessionId: string; onSaved: (id: string) => void }) {
  const events = useSessionEvents(sessionId);
  const [saving, setSaving] = useState(false);
  const { projectId } = useProjectScope();

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
    api.createWorkflow(draft, 'chat', projectId).then((d) => {
      toast.success('编排已保存');
      onSaved(d.id);
    }).catch((e) => toast.error(String(e))).finally(() => setSaving(false));
  };

  return (
    <div className="flex w-[46%] flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <b className="font-display text-[14px] font-semibold text-ink">编排草图</b>
        <Button variant="default" size="sm" disabled={!draft || saving} onClick={save}>
          <Save size={13} /> {saving ? '保存中…' : '保存编排'}
        </Button>
      </header>
      {draft ? (
        <>
          <div className="px-4 py-1.5 text-xs text-dim">
            {draft.name} · {draft.nodes.length} 节点
          </div>
          <div className="flex-1">
            <FlowGraph def={draft} />
          </div>
        </>
      ) : (
        <div className="p-6 text-sm text-dim">在左侧描述你要的流程，agent 会调用 emit_workflow 生成草图，实时渲染在这里。</div>
      )}
    </div>
  );
}

export function Designer({ onSaved, onBack }: { onSaved: (workflowId: string) => void; onBack: () => void }) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 设计会话是一次性辅助会话：离开即终止，不在线程列表残留
  useEffect(() => {
    let cancelled = false;
    let spawnedId: string | null = null;
    api
      .machines()
      .then((machines: MachineRow[]) => {
        const machine = machines[0];
        if (!machine) {
          throw new Error('没有在线机器，无法启动设计会话');
        }
        return api.spawn({ machineId: machine.id, cwd: '/root', designer: true });
      })
      .then(({ sessionId }) => {
        spawnedId = sessionId ?? null;
        return api.sessions().then((all) => all.find((s) => s.id === sessionId) ?? null);
      })
      .then((row) => {
        if (!cancelled) {
          setSession(row);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      if (spawnedId) {
        void api.kill(spawnedId).catch(() => {});
      }
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <b className="font-display text-[14px] font-semibold text-ink">对话编排流水线</b>
        <span className="hidden text-xs text-faint sm:inline">描述流程 → 实时出图 → 保存（不启动）</span>
      </header>
      {error && <div className="m-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      {session ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 overflow-hidden border-r border-line">
            <SessionView session={session} />
          </div>
          <DraftPane sessionId={session.id} onSaved={onSaved} />
        </div>
      ) : (
        !error && (
          <div className="flex items-center gap-2 p-6 text-sm text-dim">
            <Spinner /> 正在启动设计会话…
          </div>
        )
      )}
    </div>
  );
}
