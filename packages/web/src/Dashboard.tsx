/**
 * Agent 工作看板页（#18）：三栏展示进行中/等我处理/最近完成。
 * 数据来自现有接口 GET /api/sessions、GET /api/runs、GET /api/approvals?status=pending。
 */

import { Badge, Card, Spinner } from './components/ui/primitives';
import { useApprovals, useRuns, useSessions, useWorkflows } from './lib/queries';
import { cn, relTime } from './lib/utils';

const RUN_TONE: Record<string, 'accent' | 'warn' | 'ok' | 'danger' | 'neutral'> = {
  running: 'accent',
  waiting_human: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

/** 从 ISO 字符串计算已过去时长（用于"进行中"条目的耗时显示） */
function elapsed(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}小时${m}分钟`;
}

export function Dashboard({
  onOpenSession,
  onOpenRun,
}: {
  onOpenSession: (id: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions();
  const { data: runs = [], isLoading: runsLoading } = useRuns();
  const { data: approvals = [], isLoading: approvalsLoading } = useApprovals();
  const { data: defs = [] } = useWorkflows();

  const loading = sessionsLoading || runsLoading || approvalsLoading;

  // 进行中：正 active 的会话
  const activeSessions = sessions.filter(
    (s) => s.state === 'thinking' || s.state === 'starting',
  );

  // 根据 runId 查找工作流名称
  const runMap = new Map(runs.map((r) => [r.id, r]));
  const defMap = new Map(defs.map((d) => [d.id, d]));
  const runName = (runId: string | null) => {
    if (!runId) return null;
    const run = runMap.get(runId);
    if (!run) return null;
    return defMap.get(run.defId)?.name ?? run.defId.slice(0, 8);
  };

  // 等我处理：待审批的会话 + pending 审批（API 已过滤 status=pending）
  const waitingSessions = sessions.filter((s) => s.state === 'waiting_approval');
  const pendingApprovals = approvals;

  // 最近完成：done/failed/cancelled run + idle 会话，均按时间排序取前 N
  const recentRuns = runs
    .filter((r) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled')
    .sort(
      (a, b) =>
        new Date(b.endedAt ?? b.startedAt).getTime() -
        new Date(a.endedAt ?? a.startedAt).getTime(),
    )
    .slice(0, 10);
  const idleSessions = sessions
    .filter((s) => s.state === 'idle')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-dim">
        <Spinner /> 加载中…
      </div>
    );
  }

  return (
    <div className="flex flex-1 gap-4 overflow-y-auto p-6">
      {/* ──── 进行中 ──── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          进行中
          {activeSessions.length > 0 && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
              {activeSessions.length}
            </span>
          )}
        </h3>

        {activeSessions.length === 0 && (
          <p className="text-sm text-dim">暂无进行中的会话。</p>
        )}

        {activeSessions.map((s) => (
          <Card
            key={s.id}
            className="cursor-pointer p-3 hover:bg-panel-2"
            onClick={() => onOpenSession(s.id)}
          >
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-accent animate-pulse" />
              <span className="truncate text-sm font-medium">
                {s.cwd.split('/').pop() || s.cwd}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dim">
              <span>{s.model ?? 'claude'}</span>
              {runName(s.runId) && <span>· {runName(s.runId)}</span>}
              {s.nodeId && <span>· {s.nodeId}</span>}
              <span>· {elapsed(s.createdAt)}</span>
            </div>
          </Card>
        ))}
      </div>

      {/* ──── 等我处理 ──── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-warn">
          等我处理
          {(waitingSessions.length + pendingApprovals.length) > 0 && (
            <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-xs text-warn">
              {waitingSessions.length + pendingApprovals.length}
            </span>
          )}
        </h3>

        {waitingSessions.length === 0 && pendingApprovals.length === 0 && (
          <p className="text-sm text-dim">暂无待处理项。</p>
        )}

        {/* 待审批项 */}
        {pendingApprovals.map((a) => (
          <Card
            key={a.id}
            className={cn(
              'cursor-pointer border-warn/40 p-3 hover:bg-panel-2',
              a.kind === 'gate' && 'border-accent/40',
            )}
            onClick={() => {
              if (a.sessionId) onOpenSession(a.sessionId);
              else if (a.runId) onOpenRun(a.runId);
            }}
          >
            <div className="flex items-center gap-2">
              <Badge tone={a.kind === 'gate' ? 'accent' : 'warn'}>
                {a.kind === 'gate' ? '门禁' : '审批'}
              </Badge>
              <span className="truncate text-sm">{a.title}</span>
            </div>
            <div className="mt-1 text-xs text-dim">
              {a.sessionId && <span>会话 {a.sessionId.slice(0, 8)}</span>}
              {a.runId && <span>运行 {a.runId.slice(0, 8)}</span>}
              {a.nodeId && <span> · 节点 {a.nodeId}</span>}
            </div>
          </Card>
        ))}

        {/* waiting_approval 的会话 */}
        {waitingSessions.map((s) => (
          <Card
            key={s.id}
            className="cursor-pointer border-warn/40 p-3 hover:bg-panel-2"
            onClick={() => onOpenSession(s.id)}
          >
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-warn" />
              <span className="truncate text-sm font-medium">
                {s.cwd.split('/').pop() || s.cwd}
              </span>
            </div>
            <div className="mt-1 text-xs text-dim">
              <span>{s.model ?? 'claude'}</span>
              <span> · {elapsed(s.createdAt)}</span>
              {s.runId && <span> · 工作流</span>}
            </div>
          </Card>
        ))}
      </div>

      {/* ──── 最近完成 ──── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          最近完成
          {(recentRuns.length + idleSessions.length) > 0 && (
            <span className="rounded-full bg-dim/15 px-1.5 py-0.5 text-xs text-dim">
              {recentRuns.length + idleSessions.length}
            </span>
          )}
        </h3>

        {recentRuns.length === 0 && idleSessions.length === 0 && (
          <p className="text-sm text-dim">暂无已完成项。</p>
        )}

        {/* 最近结束的 run */}
        {recentRuns.map((r) => (
          <Card
            key={r.id}
            className="cursor-pointer p-3 hover:bg-panel-2"
            onClick={() => onOpenRun(r.id)}
          >
            <div className="flex items-center gap-2">
              <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
              <span className="truncate text-sm">
                {defs.find((d) => d.id === r.defId)?.name ?? r.defId.slice(0, 8)}
              </span>
            </div>
            <div className="mt-1 text-xs text-dim">
              {r.endedAt ? relTime(r.endedAt) : relTime(r.startedAt)}
            </div>
          </Card>
        ))}

        {/* 列表分隔 */}
        {recentRuns.length > 0 && idleSessions.length > 0 && (
          <hr className="border-line/60" />
        )}

        {/* idle 会话 */}
        {idleSessions.map((s) => (
          <Card
            key={s.id}
            className="cursor-pointer p-3 hover:bg-panel-2"
            onClick={() => onOpenSession(s.id)}
          >
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-ok" />
              <span className="truncate text-sm font-medium">
                {s.cwd.split('/').pop() || s.cwd}
              </span>
            </div>
            <div className="mt-1 text-xs text-dim">
              <span>{s.model ?? 'claude'}</span>
              <span> · {relTime(s.createdAt)}</span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
