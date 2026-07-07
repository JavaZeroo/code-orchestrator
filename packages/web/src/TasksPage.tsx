/**
 * 任务 tab（#37）：血缘树展示、内嵌 RunView、对话优先新建任务、实时刷新。
 * 消费 GET /api/work?projectId=<id>，project 类型根节点自动提升 children。
 */

import { ArrowLeft, ChevronDown, ExternalLink, FileText, GitPullRequest, ListTree, MessageSquareText, Play, Plus, Save, UserCheck, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionRow, WorkItem, WorkflowDef, WorkflowDefRow } from './api';
import { api } from './api';
import { FlowGraph } from './FlowGraph';
import { RunView } from './RunView';
import { SessionView } from './SessionView';
import { StartForm } from './components/StartForm';
import { Button } from './components/ui/button';
import { Badge, Card, type BadgeTone, Spinner, StatusDot } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useProjects, useWork, useWorkflows } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn, relTime } from './lib/utils';
import { useSessionEvents } from './useEvents';

/** work_items 的 status → tone（注意与 run.status 取值集不同，别复用 RUN_TONE） */
const WORK_TONE: Record<string, BadgeTone> = {
  pending: 'neutral', active: 'run', waiting_human: 'human',
  blocked: 'warn', done: 'ok', failed: 'danger', cancelled: 'neutral',
};
const WORK_LABEL: Record<string, string> = {
  pending: '待运行', active: '进行中', waiting_human: '待处理',
  blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消',
};

/** refs 取 string 值 */
const s = (refs: Record<string, unknown>, k: string) => String(refs[k] ?? '');

/** PR 外链拼接（refs 没存 url） */
const prUrl = (refs: Record<string, unknown>) => {
  const base = s(refs, 'forge') === 'gitcode' ? 'https://gitcode.com' : 'https://github.com';
  const seg = s(refs, 'forge') === 'gitcode' ? 'merge_requests' : 'pull';
  return `${base}/${s(refs, 'repo')}/${seg}/${s(refs, 'number')}`;
};

/** 类型图标 */
function TypeIcon({ type, className }: { type: string; className?: string }) {
  const cls = cn('shrink-0 text-faint', className ?? 'size-4');
  switch (type) {
    case 'requirement':
      return <FileText className={cls} />;
    case 'run':
      return <ListTree className={cls} />;
    case 'node':
      return <MessageSquareText className={cls} />;
    case 'pr':
      return <GitPullRequest className={cls} />;
    case 'approval':
      return <UserCheck className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

function WorkNode({
  item,
  depth,
  onOpenRun,
  onOpenSession,
}: {
  item: WorkItem;
  depth: number;
  onOpenRun: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = item.children.length > 0;
  const tone = WORK_TONE[item.status] ?? 'neutral';

  const handleClick = () => {
    if (item.type === 'run' && s(item.refs, 'runId')) {
      onOpenRun(s(item.refs, 'runId'));
    } else if (item.type === 'node' && s(item.refs, 'sessionId')) {
      onOpenSession(s(item.refs, 'sessionId'));
    } else if (item.type === 'pr') {
      window.open(prUrl(item.refs), '_blank', 'noreferrer');
    } else if (item.type === 'approval' && s(item.refs, 'runId')) {
      onOpenRun(s(item.refs, 'runId'));
    } else if (hasChildren) {
      setOpen((v) => !v);
    }
  };

  const extLink =
    item.type === 'requirement' && s(item.refs, 'url') ? (
      <a
        href={s(item.refs, 'url')}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 text-faint hover:text-accent"
        onClick={(e) => e.stopPropagation()}
        title="打开 issue"
      >
        <ExternalLink size={12} />
      </a>
    ) : null;

  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-panel-2"
        style={{ marginLeft: depth * 20 }}
        onClick={handleClick}
      >
        {hasChildren ? (
          <ChevronDown size={14} className={cn('shrink-0 text-faint transition-transform', !open && '-rotate-90')} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <TypeIcon type={item.type} />
        <span className="min-w-0 flex-1 truncate font-medium text-ink-2">{item.title ?? item.type}</span>
        {extLink}
        <Badge tone={tone}>{WORK_LABEL[item.status] ?? item.status}</Badge>
        {item.owner && <span className="mono-nums shrink-0 text-[10px] text-faint">{item.owner}</span>}
      </div>
      {hasChildren && open && (
        <div>
          {item.children.map((c) => (
            <WorkNode key={c.id} item={c} depth={depth + 1} onOpenRun={onOpenRun} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────── 对话优先新建任务 ──────── */

interface TaskPlan {
  defId: string;
  vars: Record<string, string>;
  summary: string;
}

function TaskPlanPane({
  taskPlan,
  workflowDraft,
  defsMap,
  activeView,
  onStart,
  onSaveAndStart,
  onAdvanced,
}: {
  taskPlan: TaskPlan | null;
  workflowDraft: WorkflowDef | null;
  defsMap: Record<string, WorkflowDefRow>;
  activeView: 'task.plan' | 'workflow.draft' | null;
  onStart: (vars: Record<string, string>) => void;
  onSaveAndStart: (def: WorkflowDef) => void;
  onAdvanced: () => void;
}) {
  const [editVars, setEditVars] = useState<Record<string, string>>({});
  // 变量同步语义（touched + 前后计划 diff）：agent 明确改动的 key 以新计划为准；
  // agent 未改的 key 保留用户手动编辑；用户新增的 key（不在新计划里）保留。
  const touchedKeys = useRef(new Set<string>());
  const prevPlanVars = useRef<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!taskPlan) {
      return;
    }
    const last = prevPlanVars.current;
    prevPlanVars.current = { ...taskPlan.vars };
    setEditVars((prev) => {
      const next = { ...taskPlan.vars };
      for (const k of Object.keys(next)) {
        if (last && last[k] === next[k] && touchedKeys.current.has(k) && k in prev) {
          next[k] = prev[k]!;
        }
      }
      for (const k of Object.keys(prev)) {
        if (!(k in next)) {
          next[k] = prev[k]!;
        }
      }
      return next;
    });
  }, [taskPlan]);

  // 按 activeView 决定渲染哪个计划（最新事件优先于类型优先级）
  if (activeView === 'workflow.draft' && workflowDraft) {
    return (
      <div className="flex w-[46%] flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
          <b className="font-display text-[14px] font-semibold text-ink">工作流草图</b>
          <Button variant="default" size="sm" disabled={saving} onClick={() => { setSaving(true); onSaveAndStart(workflowDraft); }}>
            <Save size={13} /> {saving ? '保存并启动…' : '保存为模板并启动'}
          </Button>
        </header>
        <div className="px-4 py-1.5 text-xs text-dim">
          {workflowDraft.name} · {workflowDraft.nodes.length} 节点
        </div>
        <div className="flex-1">
          <FlowGraph def={workflowDraft} />
        </div>
      </div>
    );
  }

  // 模板计划路线
  if (activeView === 'task.plan' && taskPlan) {
    const def = defsMap[taskPlan.defId];
    const varKeys = Object.keys(taskPlan.vars);
    return (
      <div className="flex w-[46%] flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
          <b className="font-display text-[14px] font-semibold text-ink">任务计划</b>
          <Button variant="default" size="sm" disabled={starting} onClick={() => { setStarting(true); onStart(editVars); }}>
            <Play size={13} /> {starting ? '启动中…' : '启动'}
          </Button>
        </header>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="rounded-lg border border-line bg-panel-2 p-3">
            <div className="flex items-center gap-2">
              <WorkflowIcon size={16} className="text-accent" />
              <span className="font-semibold text-ink">{def?.name ?? taskPlan.defId}</span>
            </div>
            <p className="mt-1.5 text-xs text-dim">{taskPlan.summary}</p>
          </div>
          {varKeys.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-dim">变量</span>
              {varKeys.map((k) => (
                <label key={k} className="flex flex-col gap-0.5 text-xs text-dim">
                  {k}
                  <input
                    className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
                    value={editVars[k] ?? ''}
                    onChange={(e) => {
                      touchedKeys.current.add(k);
                      setEditVars({ ...editVars, [k]: e.target.value });
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-[46%] flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <b className="font-display text-[14px] font-semibold text-ink">任务计划</b>
      </header>
      <div className="p-6 text-sm text-dim">
        在左侧描述你要做的任务，agent 会从当前项目的模板中选一个合适的并给出计划。
      </div>
      <div className="mt-auto border-t border-line px-4 py-2.5">
        <button
          className="text-xs text-faint underline decoration-dotted underline-offset-2 hover:text-accent"
          onClick={onAdvanced}
        >
          高级：直接选模板 →
        </button>
      </div>
    </div>
  );
}

function TaskIntake({
  projectId,
  onStarted,
  onBack,
}: {
  projectId: string | null;
  onStarted: (runId: string) => void;
  onBack: () => void;
}) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { data: allDefs = [] } = useWorkflows();
  const { data: projects = [] } = useProjects();
  const currentProject = projectId ? projects.find((p) => p.id === projectId) : null;
  const [advDefId, setAdvDefId] = useState('');
  // projects 数据可能晚于首渲染到位，默认模板用 effect 同步（用户已选过则不覆盖）
  useEffect(() => {
    if (currentProject?.defaultWorkflow) {
      setAdvDefId((prev) => prev || currentProject.defaultWorkflow!);
    }
  }, [currentProject?.defaultWorkflow]);

  // 按项目过滤非 archived 的模板
  const projectDefs = useMemo(
    () => allDefs.filter((d) => d.projectId === projectId && d.archived !== 'yes'),
    [allDefs, projectId],
  );
  const defsMap = useMemo(() => Object.fromEntries(projectDefs.map((d) => [d.id, d])), [projectDefs]);

  // 挂载时起会话，优先选有 dev label 的机器
  useEffect(() => {
    let cancelled = false;
    api
      .machines()
      .then((machines) => {
        const machine = machines.find((m) => m.labels?.includes('dev')) ?? machines[0];
        if (!machine) {
          throw new Error('没有在线机器，无法启动会话');
        }
        return api.spawn({ machineId: machine.id, cwd: '/root', taskIntake: true, projectId });
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
  }, [projectId]);

  const events = useSessionEvents(session?.id ?? '');

  // 按事件时序决定优先展示哪个计划（最新的为准）
  const lastPlanType: 'task.plan' | 'workflow.draft' | null = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i]?.type;
      if (t === 'task.plan' || t === 'workflow.draft') return t;
    }
    return null;
  }, [events]);

  const taskPlan = useMemo<TaskPlan | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'task.plan') {
        return events[i]!.payload as TaskPlan;
      }
    }
    return null;
  }, [events]);

  const workflowDraft = useMemo<WorkflowDef | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'workflow.draft') {
        return events[i]!.payload as WorkflowDef;
      }
    }
    return null;
  }, [events]);

  const startPlan = (vars: Record<string, string>) => {
    if (!taskPlan) return;
    api.startRun(taskPlan.defId, vars, projectId)
      .then((d) => onStarted(d.runId))
      .catch((e) => toast.error(String(e)));
  };

  const saveAndStart = async (graph: WorkflowDef) => {
    try {
      const { id } = await api.createWorkflow(graph, 'chat', projectId);
      const { runId } = await api.startRun(id, {}, projectId);
      toast.success('模板已创建并启动');
      onStarted(runId);
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 高级：直接选模板
  if (showAdvanced) {
    const selDef = projectDefs.find((d) => d.id === advDefId);
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
          <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(false)}>
            <ArrowLeft size={14} /> 返回对话
          </Button>
          <b className="font-display text-[14px] font-semibold text-ink">直接选模板</b>
        </header>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <p className="text-xs text-dim">从已有模板中选一个启动。对话优先入口可以按需自动匹配。</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-dim">模板</label>
            <Select value={advDefId} onValueChange={setAdvDefId}>
              <SelectTrigger>
                <SelectValue placeholder="选择模板" />
              </SelectTrigger>
              <SelectContent>
                {projectDefs.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selDef && (
            <StartForm
              def={selDef}
              onStarted={(runId) => onStarted(runId)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <b className="font-display text-[14px] font-semibold text-ink">对话式新建任务</b>
        <span className="hidden text-xs text-faint sm:inline">描述需求 → agent 推荐模板 → 确认启动</span>
      </header>
      {error ? (
        <div className="m-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      ) : session ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 overflow-hidden border-r border-line">
            <SessionView session={session} />
          </div>
          <TaskPlanPane
            taskPlan={taskPlan}
            workflowDraft={workflowDraft}
            defsMap={defsMap}
            activeView={lastPlanType}
            onStart={startPlan}
            onSaveAndStart={saveAndStart}
            onAdvanced={() => setShowAdvanced(true)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 p-6 text-sm text-dim">
          <Spinner /> 正在启动会话…
        </div>
      )}
    </div>
  );
}

/* ──────── TasksPage ──────── */

export function TasksPage({
  onOpenSession,
  openRunId,
  onOpenRunConsumed,
}: {
  onOpenSession: (id: string) => void;
  openRunId?: string | null;
  onOpenRunConsumed?: () => void;
}) {
  const [view, setView] = useState<'tree' | 'taskIntake' | { run: string }>(openRunId ? { run: openRunId } : 'tree');
  const { projectId } = useProjectScope();
  const { data, isLoading } = useWork(projectId);

  // 监听外部 openRunId（通知中心深链）
  useEffect(() => {
    if (openRunId) {
      setView({ run: openRunId });
      onOpenRunConsumed?.();
    }
  }, [openRunId, onOpenRunConsumed]);

  // 全局 WS 订阅，对 run/requirement/approval 事件失效 work 缓存
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client`);
    ws.onmessage = (e) => {
      try {
        const t = ((JSON.parse(e.data as string) as { type?: string }).type ?? '') as string;
        if (/^(run|requirement|approval)\./.test(t)) invalidate('work');
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  // RunView
  if (typeof view === 'object' && 'run' in view) {
    return <RunView runId={view.run} onOpenSession={onOpenSession} onBack={() => setView('tree')} />;
  }

  // TaskIntake 对话优先新建
  if (view === 'taskIntake') {
    return (
      <TaskIntake
        projectId={projectId}
        onStarted={(runId) => setView({ run: runId })}
        onBack={() => setView('tree')}
      />
    );
  }

  // unwrap project roots → requirement（从 project 下提升）+ 手动 run
  const roots = (data?.tree ?? []).flatMap((r) => (r.type === 'project' ? r.children : [r]));
  // 按 updatedAt desc
  roots.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-dim">
          本项目的任务血缘树 —— <span className="text-ink-2">从需求到运行到审批</span>，可追溯每次触发的完整链路。
        </p>
        <Button variant="default" size="sm" className="shrink-0" onClick={() => setView('taskIntake')}>
          <Plus size={14} /> 新建任务
        </Button>
      </div>

      {/* 空态 / 树 */}
      {isLoading ? (
        <div className="py-16 text-center text-sm text-faint">加载中…</div>
      ) : roots.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <ListTree size={26} className="text-faint" />
          <p className="text-sm text-dim">本项目还没有任务，点右上「新建任务」开始。</p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-2">
          {roots.map((item) => (
            <WorkNode
              key={item.id}
              item={item}
              depth={0}
              onOpenRun={(runId) => setView({ run: runId })}
              onOpenSession={onOpenSession}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
