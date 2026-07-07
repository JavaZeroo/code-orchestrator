/**
 * 看板：注意力页。顶部 KPI 读数条 + 两栏(进行中/等我处理)。
 * 数据来自 GET /api/sessions、/api/runs、/api/approvals?status=pending。
 */

import { Activity, ArrowRight, CheckCircle2, type LucideIcon, GitPullRequest, Workflow as WorkflowIcon } from 'lucide-react';
import { Badge, Card, Spinner, StatusDot } from './components/ui/primitives';
import { useApprovals, useRuns, useSessions, useWorkflows } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn } from './lib/utils';

const RUN_TONE: Record<string, 'accent' | 'run' | 'ok' | 'danger' | 'neutral' | 'human'> = {
  running: 'run',
  waiting_human: 'human',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};
const RUN_LABEL: Record<string, string> = { running: '运行中', waiting_human: '待处理', done: '完成', failed: '失败', cancelled: '取消' };

function elapsed(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}时${min % 60}分`;
}

function Stat({ icon: Icon, label, value, tone, live }: { icon: LucideIcon; label: string; value: number; tone: string; live?: boolean }) {
  const toneCls: Record<string, string> = {
    accent: 'text-accent border-accent/25 bg-accent/5',
    run: 'text-run border-run/25 bg-run/5',
    human: 'text-human border-human/25 bg-human/5',
    ok: 'text-ok border-ok/25 bg-ok/5',
    neutral: 'text-dim border-line bg-panel-2',
  };
  return (
    <Card className={cn('relative flex items-center gap-3.5 overflow-hidden p-4', value > 0 && tone === 'human' && 'ring-1 ring-human/30')}>
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl border', toneCls[tone] ?? toneCls.neutral)}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-2xl leading-none font-semibold tracking-tight text-ink tabular-nums">{value}</span>
          {live && value > 0 && <StatusDot tone={tone} live className="mb-0.5" />}
        </div>
        <div className="mt-1 text-[11px] font-medium tracking-wide text-dim">{label}</div>
      </div>
    </Card>
  );
}

function Lane({ title, tone, count, children }: { title: string; tone: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div className="flex items-center gap-2 px-0.5">
        <StatusDot tone={tone} live={tone === 'run' && count > 0} />
        <h3 className="text-[13px] font-semibold text-ink-2">{title}</h3>
        <span className="mono-nums rounded-full bg-panel-2 px-1.5 text-[11px] text-dim">{count}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function RowCard({ onClick, dot, live, title, meta, right }: { onClick?: () => void; dot: string; live?: boolean; title: string; meta: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card
      onClick={onClick}
      className={cn('group flex items-center gap-2.5 p-2.5 transition-all', onClick && 'cursor-pointer hover:border-line-2 hover:bg-panel-2')}
    >
      <StatusDot tone={dot} live={live} className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink-2">{title}</div>
        <div className="mono-nums mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-faint">{meta}</div>
      </div>
      {right}
      {onClick && <ArrowRight size={13} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />}
    </Card>
  );
}

export function Dashboard({ onOpenSession, onOpenRun }: { onOpenSession: (id: string) => void; onOpenRun: (runId: string) => void }) {
  const { data: allSessions = [], isLoading: sl } = useSessions();
  const { data: allRuns = [], isLoading: rl } = useRuns();
  const { data: allApprovals = [], isLoading: al } = useApprovals();
  const { data: defs = [] } = useWorkflows();
  const { inScope } = useProjectScope();

  const runMap = new Map(allRuns.map((r) => [r.id, r]));
  const defMap = new Map(defs.map((d) => [d.id, d]));
  // 全部 scoped 到当前项目：run 看自身，session 看自身或经 run，approval 看其 run/session 归属
  const runs = allRuns.filter((r) => inScope(r.projectId));
  const sessions = allSessions.filter((s) => inScope(s.projectId ?? (s.runId ? runMap.get(s.runId)?.projectId ?? null : null)));
  const approvals = allApprovals.filter((a) =>
    inScope(a.runId ? runMap.get(a.runId)?.projectId ?? null : allSessions.find((s) => s.id === a.sessionId)?.projectId ?? null),
  );
  const runName = (runId: string | null) => (runId ? defMap.get(runMap.get(runId)?.defId ?? '')?.name ?? null : null);

  const activeSessions = sessions.filter((s) => s.state === 'thinking' || s.state === 'starting');
  const waitingSessions = sessions.filter((s) => s.state === 'waiting_approval');
  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'waiting_human');
  const doneRuns = runs.filter((r) => r.status === 'done');
  const waitingCount = waitingSessions.length + approvals.length;

  if (sl || rl || al) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-dim">
        <Spinner /> 加载中…
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
      {/* KPI 读数条 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Activity} label="进行中 Agent" value={activeSessions.length} tone="run" live />
        <Stat icon={GitPullRequest} label="等我处理" value={waitingCount} tone="human" />
        <Stat icon={WorkflowIcon} label="活跃工作流" value={activeRuns.length} tone="accent" />
        <Stat icon={CheckCircle2} label="已完成" value={doneRuns.length} tone="ok" />
      </div>

      {/* 两栏看板 */}
      <div className="flex flex-1 flex-col gap-5 lg:flex-row">
        <Lane title="进行中" tone="run" count={activeSessions.length}>
          {activeSessions.length === 0 && <p className="px-1 py-4 text-xs text-faint">暂无进行中的会话</p>}
          {activeSessions.map((s) => (
            <RowCard
              key={s.id}
              onClick={() => onOpenSession(s.id)}
              dot="run"
              live
              title={s.cwd.split('/').pop() || s.cwd}
              meta={
                <>
                  <span className="text-accent/80">{s.model ?? 'claude'}</span>
                  {runName(s.runId) && <span>· {runName(s.runId)}</span>}
                  {s.nodeId && <span>· {s.nodeId}</span>}
                  <span>· {elapsed(s.createdAt)}</span>
                </>
              }
            />
          ))}
        </Lane>

        <Lane title="等我处理" tone="human" count={waitingCount}>
          {waitingCount === 0 && <p className="px-1 py-4 text-xs text-faint">没有待你处理的项 ✓</p>}
          {approvals.map((a) => (
            <RowCard
              key={a.id}
              onClick={() => (a.sessionId ? onOpenSession(a.sessionId) : a.runId ? onOpenRun(a.runId) : undefined)}
              dot="human"
              title={a.title}
              meta={
                <>
                  {a.runId && <span>run {a.runId.slice(0, 8)}</span>}
                  {a.nodeId && <span>· {a.nodeId}</span>}
                </>
              }
              right={<Badge tone={a.kind === 'gate' ? 'human' : 'warn'}>{a.kind === 'gate' ? '合并门' : '审批'}</Badge>}
            />
          ))}
          {waitingSessions.map((s) => (
            <RowCard
              key={s.id}
              onClick={() => onOpenSession(s.id)}
              dot="human"
              title={s.cwd.split('/').pop() || s.cwd}
              meta={<span>{s.model ?? 'claude'} · {elapsed(s.createdAt)}</span>}
              right={<Badge tone="warn">工具审批</Badge>}
            />
          ))}
        </Lane>
      </div>
    </div>
  );
}
