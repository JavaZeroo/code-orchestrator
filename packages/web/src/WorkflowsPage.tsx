import { ChevronDown, MessageCircle, Play, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type RunRow, type WorkflowDefRow, api } from './api';
import { Designer } from './Designer';
import { RunView } from './RunView';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label, StatusDot } from './components/ui/primitives';
import { useRuns, useWorkflows } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn, relTime } from './lib/utils';

const RUN_TONE: Record<string, 'accent' | 'run' | 'warn' | 'ok' | 'danger' | 'neutral' | 'human'> = {
  running: 'run',
  waiting_human: 'human',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};
const RUN_LABEL: Record<string, string> = { running: '运行中', waiting_human: '待处理', done: '完成', failed: '失败', cancelled: '取消' };

function StartForm({ def, onStarted }: { def: WorkflowDefRow; onStarted: (runId: string) => void }) {
  const varKeys = Object.keys(def.graph.vars ?? {});
  const needsCwd = def.graph.nodes.some((n) => n.type === 'agent' && !n.cwd);
  const keys = needsCwd && !varKeys.includes('cwd') ? ['cwd', ...varKeys] : varKeys;
  const [vars, setVars] = useState<Record<string, string>>({ ...(def.graph.vars ?? {}) });
  const [busy, setBusy] = useState(false);
  const { projectId } = useProjectScope();

  const start = () => {
    setBusy(true);
    api.startRun(def.id, vars, projectId).then((d) => onStarted(d.runId)).catch((e) => toast.error(String(e))).finally(() => setBusy(false));
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
  const { data: allDefs = [] } = useWorkflows();
  const { data: allRuns = [] } = useRuns();
  const { inScope } = useProjectScope();
  const defs = allDefs.filter((d) => inScope(d.projectId));
  const runs = allRuns.filter((r) => inScope(r.projectId));
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
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto p-6">
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm text-dim">
            流水线定义与运行记录 —— <span className="text-ink-2">对话式描述你要的流程</span>，agent 生成为可执行图。
          </p>
          <Button variant="default" size="sm" className="shrink-0" onClick={() => setView('designer')}>
            <MessageCircle size={14} /> 对话式新建
          </Button>
        </div>
        {defs.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 py-12 text-center">
            <WorkflowIcon size={26} className="text-faint" />
            <p className="text-sm text-dim">还没有工作流 —— 点「对话式新建」，跟 agent 说你要什么流程。</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {defs.map((d) => (
              <Card key={d.id} className="overflow-hidden p-0 transition-colors hover:border-line-2">
                <button
                  className="flex w-full items-center gap-2.5 p-3.5 text-left"
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-accent">
                    <WorkflowIcon size={15} />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[14px] font-semibold text-ink">{d.name}</span>
                    <span className="mono-nums block text-[11px] text-faint">
                      {d.graph.nodes.length} 节点 · v{d.version} · {d.createdVia === 'chat' ? '对话生成' : '手工'}
                    </span>
                  </span>
                  <ChevronDown size={15} className={cn('shrink-0 text-faint transition-transform', expanded === d.id && 'rotate-180')} />
                </button>
                {expanded === d.id && (
                  <div className="px-3.5 pb-3.5">
                    <StartForm def={d} onStarted={(runId) => setView({ run: runId })} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>
      <section>
        <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-ink-2">
          运行记录
          {runs.length > 0 && <span className="mono-nums rounded-full bg-panel-2 px-1.5 text-[11px] text-dim">{runs.length}</span>}
        </h2>
        <div className="flex flex-col gap-1.5">
          {runs.map((r: RunRow) => (
            <Card
              key={r.id}
              className="group flex cursor-pointer items-center gap-2.5 p-2.5 transition-all hover:border-line-2 hover:bg-panel-2"
              onClick={() => setView({ run: r.id })}
            >
              <StatusDot tone={RUN_TONE[r.status] ?? 'neutral'} live={r.status === 'running'} />
              <span className="flex-1 truncate text-[13px] font-medium text-ink-2">
                {defs.find((d) => d.id === r.defId)?.name ?? r.defId.slice(0, 8)}
              </span>
              <span className="mono-nums text-[11px] text-faint">{relTime(r.startedAt)}</span>
              <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{RUN_LABEL[r.status] ?? r.status}</Badge>
            </Card>
          ))}
          {runs.length === 0 && <p className="py-6 text-center text-sm text-faint">还没有运行记录。</p>}
        </div>
      </section>
    </div>
  );
}
