/**
 * 对话优先新建任务（TaskIntake）+ 执行计划/模板面板。
 * 受理会话惰性创建（首条输入才 spawn，离开自动终止）；右侧空态即模板列表，
 * 模板管理（改名/归档/恢复/设默认/查看图）就地完成，不另开页面。
 */

import { Archive, ArchiveRestore, ArrowLeft, Pencil, Play, Save, Send, Star, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionRow, WorkflowDef, WorkflowDefRow } from './api';
import { api } from './api';
import { FlowGraph } from './FlowGraph';
import { SessionView } from './SessionView';
import { StartForm } from './components/StartForm';
import { Button } from './components/ui/button';
import { Badge, Spinner, Textarea } from './components/ui/primitives';
import { invalidate, useProjects, useRuns, useWorkflows } from './lib/queries';
import { cn } from './lib/utils';
import { useSessionEvents } from './useEvents';

/* ──────── 模板卡片 ──────── */

function TemplateCard({
  def,
  isDefault,
  runCount,
  canSetDefault,
  onStarted,
  onSetDefault,
}: {
  def: WorkflowDefRow;
  isDefault: boolean;
  runCount: number;
  canSetDefault: boolean;
  onStarted: (runId: string) => void;
  onSetDefault: () => void;
}) {
  const [expand, setExpand] = useState<'none' | 'start' | 'graph'>('none');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(def.name);

  const flow = def.graph.nodes.map((n) => n.title ?? n.id).join(' → ');

  const rename = () => {
    const t = name.trim();
    setRenaming(false);
    if (!t || t === def.name) {
      setName(def.name);
      return;
    }
    api.patchWorkflow(def.id, { name: t })
      .then(() => invalidate('workflows'))
      .catch((e) => { toast.error(String(e)); setName(def.name); });
  };

  const archive = () => {
    api.patchWorkflow(def.id, { archived: 'yes' })
      .then(() => { invalidate('workflows'); toast('已归档，可在下方「已归档」里恢复'); })
      .catch((e) => toast.error(String(e)));
  };

  return (
    <div className="rounded-lg border border-line bg-panel/60">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename();
              if (e.key === 'Escape') { setRenaming(false); setName(def.name); }
            }}
            className="min-w-0 flex-1 rounded-md border border-accent bg-bg px-2 py-0.5 text-[13px] text-ink outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink" title={def.name}>{def.name}</span>
        )}
        {isDefault && <Badge tone="ok" className="shrink-0">默认</Badge>}
        <span className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" title="改名" onClick={() => setRenaming(true)}>
            <Pencil size={13} />
          </Button>
          {canSetDefault && !isDefault && (
            <Button variant="ghost" size="icon-sm" title="设为项目默认模板" onClick={onSetDefault}>
              <Star size={13} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" title="归档" onClick={archive}>
            <Archive size={13} />
          </Button>
        </span>
      </div>
      <div className="truncate px-3 pt-1 text-[11px] text-dim" title={flow}>{flow}</div>
      <div className="mono-nums flex items-center gap-2 px-3 pt-1 pb-2.5 text-[10px] text-faint">
        {def.graph.nodes.length} 节点 · 跑过 {runCount} 次 · {def.createdVia === 'chat' ? '对话编排' : '手动创建'}
        <span className="ml-auto flex gap-1.5">
          <Button variant="secondary" size="sm" className="!text-[11px]" onClick={() => setExpand(expand === 'graph' ? 'none' : 'graph')}>
            {expand === 'graph' ? '收起' : '查看图'}
          </Button>
          <Button variant="default" size="sm" className="!text-[11px]" onClick={() => setExpand(expand === 'start' ? 'none' : 'start')}>
            <Play size={11} /> 选用
          </Button>
        </span>
      </div>
      {expand === 'graph' && (
        <div className="h-56 border-t border-line">
          <FlowGraph def={def.graph} />
        </div>
      )}
      {expand === 'start' && (
        <div className="border-t border-line px-3 pb-3">
          <StartForm def={def} onStarted={onStarted} />
        </div>
      )}
    </div>
  );
}

/* ──────── 模板列表（右侧空态） ──────── */

function TemplateList({
  projectId,
  onStarted,
}: {
  projectId: string | null;
  onStarted: (runId: string) => void;
}) {
  const { data: allDefs = [] } = useWorkflows();
  const { data: runs = [] } = useRuns();
  const { data: projects = [] } = useProjects();
  const [showArchived, setShowArchived] = useState(false);

  const currentProject = projectId ? projects.find((p) => p.id === projectId) : null;
  const defs = useMemo(
    () => allDefs.filter((d) => d.projectId === projectId && d.archived !== 'yes'),
    [allDefs, projectId],
  );
  const archivedDefs = useMemo(
    () => allDefs.filter((d) => d.projectId === projectId && d.archived === 'yes'),
    [allDefs, projectId],
  );
  const runCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) m.set(r.defId, (m.get(r.defId) ?? 0) + 1);
    return m;
  }, [runs]);

  const setDefault = (defId: string) => {
    if (!projectId) return;
    api.patchProject(projectId, { defaultWorkflow: defId })
      .then(() => { invalidate('projects'); toast.success('已设为项目默认模板'); })
      .catch((e) => toast.error(String(e)));
  };

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
      <p className="text-xs text-dim">
        模板 = 保存下来的多节点工作流。左侧描述需求，agent 会挑一个填好变量给出计划（没有合适的会现场编排）；也可以直接「选用」手动填变量启动。
      </p>
      {defs.map((d) => (
        <TemplateCard
          key={d.id}
          def={d}
          isDefault={currentProject?.defaultWorkflow === d.id}
          runCount={runCounts.get(d.id) ?? 0}
          canSetDefault={!!projectId}
          onStarted={onStarted}
          onSetDefault={() => setDefault(d.id)}
        />
      ))}
      {defs.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
          此项目还没有模板。在左侧描述需求，agent 现场编排后可「保存为模板并启动」。
        </p>
      )}
      {archivedDefs.length > 0 && (
        <>
          <button
            className="self-start px-1 pt-1 text-[11px] text-faint hover:text-ink-2"
            onClick={() => setShowArchived((v) => !v)}
          >
            已归档 {archivedDefs.length} 个 {showArchived ? '▾' : '▸'}
          </button>
          {showArchived && archivedDefs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-lg border border-line/60 bg-panel/30 px-3 py-1.5 opacity-70">
              <span className="min-w-0 flex-1 truncate text-xs text-dim" title={d.name}>{d.name}</span>
              <span className="mono-nums shrink-0 text-[10px] text-faint">{def2NodeCount(d)} 节点</span>
              <Button
                variant="ghost"
                size="icon-sm"
                title="恢复"
                onClick={() =>
                  api.patchWorkflow(d.id, { archived: 'no' })
                    .then(() => invalidate('workflows'))
                    .catch((e) => toast.error(String(e)))
                }
              >
                <ArchiveRestore size={13} />
              </Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function def2NodeCount(d: WorkflowDefRow): number {
  return d.graph.nodes?.length ?? 0;
}

/* ──────── 执行计划面板 ──────── */

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
  projectId,
  onStart,
  onSaveAndStart,
  onStarted,
}: {
  taskPlan: TaskPlan | null;
  workflowDraft: WorkflowDef | null;
  defsMap: Record<string, WorkflowDefRow>;
  activeView: 'task.plan' | 'workflow.draft' | null;
  projectId: string | null;
  onStart: (vars: Record<string, string>) => void;
  onSaveAndStart: (def: WorkflowDef) => void;
  onStarted: (runId: string) => void;
}) {
  const [editVars, setEditVars] = useState<Record<string, string>>({});
  const touchedKeys = useRef(new Set<string>());
  const prevPlanVars = useRef<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!taskPlan) return;
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

  if (activeView === 'workflow.draft' && workflowDraft) {
    return (
      <div className="flex w-[46%] flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
          <b className="font-display text-[14px] font-semibold text-ink">编排草图</b>
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

  if (activeView === 'task.plan' && taskPlan) {
    const def = defsMap[taskPlan.defId];
    const varKeys = Object.keys(taskPlan.vars);
    return (
      <div className="flex w-[46%] flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
          <b className="font-display text-[14px] font-semibold text-ink">执行计划</b>
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
      <header className="flex items-center border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <b className="font-display text-[14px] font-semibold text-ink">模板</b>
      </header>
      <TemplateList projectId={projectId} onStarted={onStarted} />
    </div>
  );
}

/* ──────── 对话优先新建任务 ──────── */

export function TaskIntake({
  projectId,
  onStarted,
  onBack,
}: {
  projectId: string | null;
  onStarted: (runId: string) => void;
  onBack: () => void;
}) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [draft, setDraft] = useState('');
  const [spawning, setSpawning] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const { data: allDefs = [] } = useWorkflows();

  const projectDefs = useMemo(
    () => allDefs.filter((d) => d.projectId === projectId && d.archived !== 'yes'),
    [allDefs, projectId],
  );
  const defsMap = useMemo(() => Object.fromEntries(projectDefs.map((d) => [d.id, d])), [projectDefs]);

  // 受理会话是一次性辅助会话：离开/切项目即终止，不在线程列表里残留
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        void api.kill(sessionRef.current).catch(() => {});
        sessionRef.current = null;
      }
    };
  }, [projectId]);
  useEffect(() => setSession(null), [projectId]);

  // 惰性创建：用户发出第一句话才 spawn（带 prompt 直接开聊）
  const startIntake = () => {
    const text = draft.trim();
    if (!text || spawning) return;
    setSpawning(true);
    api.machines()
      .then((machines) => {
        const machine = machines.find((m) => m.labels?.includes('dev')) ?? machines[0];
        if (!machine) throw new Error('没有在线机器，无法启动会话');
        return api.spawn({ machineId: machine.id, cwd: '/root', taskIntake: true, projectId, prompt: text });
      })
      .then(({ sessionId }) => api.sessions().then((all) => all.find((s) => s.id === sessionId) ?? null))
      .then((row) => {
        if (row) {
          sessionRef.current = row.id;
          setSession(row);
          setDraft('');
        }
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setSpawning(false));
  };

  const events = useSessionEvents(session?.id ?? '');

  const lastPlanType: 'task.plan' | 'workflow.draft' | null = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i]?.type;
      if (t === 'task.plan' || t === 'workflow.draft') return t;
    }
    return null;
  }, [events]);

  const taskPlan = useMemo<TaskPlan | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'task.plan') return events[i]!.payload as TaskPlan;
    }
    return null;
  }, [events]);

  const workflowDraft = useMemo<WorkflowDef | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'workflow.draft') return events[i]!.payload as WorkflowDef;
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

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <b className="font-display text-[14px] font-semibold text-ink">对话式规划</b>
        <span className="hidden text-xs text-faint sm:inline">描述需求 → agent 推荐模板或现场编排 → 确认启动</span>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className={cn('flex flex-1 overflow-hidden border-r border-line', !session && 'items-center justify-center')}>
          {session ? (
            <SessionView session={session} />
          ) : (
            <div className="w-full max-w-xl px-6">
              <h2 className="mb-2 text-center font-display text-xl font-semibold tracking-tight text-ink">要自动化做什么？</h2>
              <p className="mb-5 text-center text-xs text-dim">
                描述任务，agent 会从右侧模板里挑一个给出执行计划；直接选用模板则不经对话
              </p>
              <div className="flex gap-2">
                <Textarea
                  rows={3}
                  value={draft}
                  placeholder="例：把 issue #78 实现掉，跑通 CI 后提 PR 等我审…"
                  disabled={spawning}
                  className="resize-none"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      startIntake();
                    }
                  }}
                />
                <Button
                  variant="default"
                  size="icon"
                  className="h-auto w-11 shrink-0"
                  disabled={!draft.trim() || spawning}
                  onClick={startIntake}
                >
                  {spawning ? <Spinner /> : <Send size={15} />}
                </Button>
              </div>
              {spawning && <p className="mt-3 text-center text-xs text-faint">正在创建受理会话…</p>}
            </div>
          )}
        </div>
        <TaskPlanPane
          taskPlan={taskPlan}
          workflowDraft={workflowDraft}
          defsMap={defsMap}
          activeView={lastPlanType}
          projectId={projectId}
          onStart={startPlan}
          onSaveAndStart={saveAndStart}
          onStarted={onStarted}
        />
      </div>
    </div>
  );
}
