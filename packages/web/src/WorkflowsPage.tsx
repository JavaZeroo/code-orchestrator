import { ChevronDown, MessageCircle, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type RunRow, type WorkflowDefRow, api } from './api';
import { Designer } from './Designer';
import { RunView } from './RunView';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label } from './components/ui/primitives';
import { useRuns, useWorkflows } from './lib/queries';
import { cn, relTime } from './lib/utils';

const RUN_TONE: Record<string, 'accent' | 'warn' | 'ok' | 'danger' | 'neutral'> = {
  running: 'accent',
  waiting_human: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

function StartForm({ def, onStarted }: { def: WorkflowDefRow; onStarted: (runId: string) => void }) {
  const varKeys = Object.keys(def.graph.vars ?? {});
  const needsCwd = def.graph.nodes.some((n) => n.type === 'agent' && !n.cwd);
  const keys = needsCwd && !varKeys.includes('cwd') ? ['cwd', ...varKeys] : varKeys;
  const [vars, setVars] = useState<Record<string, string>>({ ...(def.graph.vars ?? {}) });
  const [busy, setBusy] = useState(false);

  const start = () => {
    setBusy(true);
    api.startRun(def.id, vars).then((d) => onStarted(d.runId)).catch((e) => toast.error(String(e))).finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
      {keys.map((k) => (
        <Label key={k}>
          {k}
          <Input
            value={vars[k] ?? ''}
            placeholder={k === 'cwd' ? '/path/to/repo（agent 节点工作目录）' : ''}
            onChange={(e) => setVars({ ...vars, [k]: e.target.value })}
          />
        </Label>
      ))}
      <Button variant="default" size="sm" className="self-start" disabled={busy} onClick={start}>
        <Play size={13} /> {busy ? '启动中…' : '启动'}
      </Button>
    </div>
  );
}

export function WorkflowsPage({
  onOpenSession,
  openRunId,
  onOpenRunConsumed,
}: {
  onOpenSession: (id: string) => void;
  /** 外部（如通知中心）要求直接打开的 run；消费后通过 onOpenRunConsumed 清空 */
  openRunId?: string | null;
  onOpenRunConsumed?: () => void;
}) {
  const [view, setView] = useState<'list' | 'designer' | { run: string }>(openRunId ? { run: openRunId } : 'list');
  const { data: defs = [] } = useWorkflows();
  const { data: runs = [] } = useRuns();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (openRunId) {
      setView({ run: openRunId });
      onOpenRunConsumed?.();
    }
  }, [openRunId, onOpenRunConsumed]);

  if (view === 'designer') {
    return <Designer onBack={() => setView('list')} onSaved={() => setView('list')} />;
  }
  if (typeof view === 'object') {
    return <RunView runId={view.run} onOpenSession={onOpenSession} onBack={() => setView('list')} />;
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">工作流</h2>
          <Button variant="default" size="sm" onClick={() => setView('designer')}>
            <MessageCircle size={14} /> 对话式新建
          </Button>
        </div>
        {defs.length === 0 && <p className="text-sm text-dim">还没有工作流——点"对话式新建"，跟 agent 说你要什么流程。</p>}
        <div className="flex flex-col gap-2">
          {defs.map((d) => (
            <Card key={d.id} className="p-3">
              <button className="flex w-full items-center justify-between" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                <span className="flex items-center gap-2">
                  <ChevronDown size={14} className={cn('text-dim transition-transform', expanded === d.id && 'rotate-180')} />
                  <b>{d.name}</b>
                </span>
                <span className="text-xs text-dim">
                  {d.graph.nodes.length} 节点 · v{d.version} · {d.createdVia === 'chat' ? '对话生成' : '手工'}
                </span>
              </button>
              {expanded === d.id && <StartForm def={d} onStarted={(runId) => setView({ run: runId })} />}
            </Card>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">运行记录</h2>
        <div className="flex flex-col gap-1.5">
          {runs.map((r: RunRow) => (
            <Card
              key={r.id}
              className="flex cursor-pointer items-center gap-3 p-2.5 hover:bg-panel-2"
              onClick={() => setView({ run: r.id })}
            >
              <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
              <span className="flex-1 text-sm">{defs.find((d) => d.id === r.defId)?.name ?? r.defId.slice(0, 8)}</span>
              <span className="text-xs text-dim">{relTime(r.startedAt)}</span>
            </Card>
          ))}
          {runs.length === 0 && <p className="text-sm text-dim">还没有运行记录。</p>}
        </div>
      </section>
    </div>
  );
}
