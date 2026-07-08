/**
 * 对话优先新建任务（TaskIntake）+ 任务计划面板（TaskPlanPane）。
 * 从 TasksPage.tsx 抽出，供首页 / 新任务态渲染。
 */

import { ArrowLeft, Play, Save, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionRow, WorkflowDef, WorkflowDefRow } from './api';
import { api } from './api';
import { FlowGraph } from './FlowGraph';
import { SessionView } from './SessionView';
import { StartForm } from './components/StartForm';
import { Button } from './components/ui/button';
import { Spinner } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { useWorkflows, useProjects } from './lib/queries';
import { useSessionEvents } from './useEvents';

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
      <header className="flex items-center justify-between border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <b className="font-display text-[14px] font-semibold text-ink">执行计划</b>
      </header>
      <div className="p-6 text-sm text-dim">
        …描述你要做的，agent 会从当前项目的模板中选一个合适的并给出计划。
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
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { data: allDefs = [] } = useWorkflows();
  const { data: projects = [] } = useProjects();
  const currentProject = projectId ? projects.find((p) => p.id === projectId) : null;
  const [advDefId, setAdvDefId] = useState('');
  useEffect(() => {
    if (currentProject?.defaultWorkflow) {
      setAdvDefId((prev) => prev || currentProject.defaultWorkflow!);
    }
  }, [currentProject?.defaultWorkflow]);

  const projectDefs = useMemo(
    () => allDefs.filter((d) => d.projectId === projectId && d.archived !== 'yes'),
    [allDefs, projectId],
  );
  const defsMap = useMemo(() => Object.fromEntries(projectDefs.map((d) => [d.id, d])), [projectDefs]);

  useEffect(() => {
    let cancelled = false;
    api
      .machines()
      .then((machines) => {
        const machine = machines.find((m) => m.labels?.includes('dev')) ?? machines[0];
        if (!machine) throw new Error('没有在线机器，无法启动会话');
        return api.spawn({ machineId: machine.id, cwd: '/root', taskIntake: true, projectId });
      })
      .then(({ sessionId }) => api.sessions().then((all) => all.find((s) => s.id === sessionId) ?? null))
      .then((row) => {
        if (!cancelled) setSession(row);
      })
      .catch((e) => setError(String(e)));
    return () => { cancelled = true; };
  }, [projectId]);

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
          {selDef && <StartForm def={selDef} onStarted={(runId) => onStarted(runId)} />}
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
        <b className="font-display text-[14px] font-semibold text-ink">对话式规划</b>
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
