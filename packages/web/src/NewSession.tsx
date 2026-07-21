import { ChevronDown, RotateCcw, SendHorizonal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type Effort, type QueuedSessionRow, type SessionAgent } from './api';
import { Input, Textarea } from './components/ui/primitives';
import * as SelectPrimitive from '@radix-ui/react-select';
import { SelectContent, SelectGroup, SelectItem, SelectLabel } from './components/ui/select';
import { invalidate, useLlmProviders, useMachines, useProjects, useQueuedSessions, useResources, useWorkflows } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn } from './lib/utils';

const DEFAULT_MODEL_VALUE = '__default__';

// ─── ChipSelect ───────────────────────────────────────────────────────────────
/** 小圆角 chip 样式的下拉选择器，基于现有 Radix Select Primitive */
function ChipSelect({
  value,
  onValueChange,
  options,
  groups,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options?: { value: string; label: string }[];
  groups?: { label: string; items: { value: string; label: string }[] }[];
  className?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-line/70 bg-bg-2/60 px-2.5 py-0.5 text-[11px] font-medium text-ink-2 outline-none transition-all hover:border-accent/40 hover:bg-accent/5 active:scale-[0.97] cursor-pointer',
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown size={11} className="text-faint" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectContent>
        {options
          ? options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))
          : groups?.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-faint">
                  {g.label}
                </SelectLabel>
                {g.items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
      </SelectContent>
    </SelectPrimitive.Root>
  );
}

// ─── ChipToggle ───────────────────────────────────────────────────────────────
/** 小圆角 chip 样式的开关按钮 */
function ChipToggle({
  value,
  onChange,
  children,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium outline-none transition-all active:scale-[0.97] cursor-pointer',
        value
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-line/70 bg-bg-2/60 text-dim hover:border-accent/40',
      )}
    >
      <span className={cn('size-1.5 rounded-full', value ? 'bg-accent' : 'bg-faint')} />
      {children}
    </button>
  );
}

// ─── NewSession ───────────────────────────────────────────────────────────────
/** ChatGPT 式居中 Composer —— 输入框 + chips + Enter 发送，机器与目录全自动就位。
 *  两种去向：直接干（会话）/ 走流水线（真建 issue → 项目流水线开跑，与 forge intake 入口合一）。 */
export function NewSession({ onCreated, onRunStarted }: { onCreated: (sessionId: string) => void; onRunStarted?: (runId: string) => void }) {
  const { data: machines = [] } = useMachines();
  const { data: projects = [] } = useProjects();
  const { data: providers = [] } = useLlmProviders();
  const { data: allDefs = [] } = useWorkflows();
  const { data: resources } = useResources();
  const { projectId } = useProjectScope();
  const { data: queuedSessions = [], refetch: refetchQueuedSessions } = useQueuedSessions(projectId);

  const project = projects.find((p) => p.id === projectId);
  const pipelines = allDefs.filter((d) => d.projectId === projectId && d.archived !== 'yes');

  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<SessionAgent>('claude');
  const [model, setModel] = useState(DEFAULT_MODEL_VALUE);
  const [effort, setEffort] = useState('default');
  const [container, setContainer] = useState(true);
  const [pipeline, setPipeline] = useState(false);
  const [pipelineDefId, setPipelineDefId] = useState('');
  const [advancedMachine, setAdvancedMachine] = useState('');
  const [advancedCwd, setAdvancedCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [updatingPriorityTaskId, setUpdatingPriorityTaskId] = useState<string | null>(null);
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 流水线默认选项目默认；切项目重置
  useEffect(() => {
    setPipeline(false);
    setPipelineDefId('');
  }, [projectId]);
  const effectiveDefId = pipelineDefId || project?.defaultWorkflow || pipelines[0]?.id || '';

  const advancedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 点击高级面板外 → 关闭
  useEffect(() => {
    if (!showAdvanced) return;
    const handler = (e: MouseEvent) => {
      if (advancedRef.current && !advancedRef.current.contains(e.target as Node)) {
        setShowAdvanced(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAdvanced]);

  const agentOptions = [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
  ];

  // 模型选项：先“默认模型”快捷项，再按 provider 分组
  const modelGroups = [
    { label: '默认', items: [{ value: DEFAULT_MODEL_VALUE, label: '默认模型' }] },
    ...providers
      .filter((p) => p.models.length > 0)
      .map((p) => ({
        label: p.name,
        items: p.models.map((m) => ({ value: `${p.name}/${m}`, label: m })),
      })),
  ];

  const effortOptions = [
    { value: 'default', label: 'effort 默认' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'xhigh', label: 'xhigh' },
    { value: 'max', label: 'max' },
  ];

  // Textarea 随内容自动长高
  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    setPrompt(e.target.value);
  };

  const submit = () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);

    // 走流水线：真建 issue → 默认流水线开跑 → 跳 run 时间线（一键直达零确认）
    if (pipeline && onRunStarted) {
      if (!projectId || !effectiveDefId) {
        toast.error('项目还没有流水线——去 项目设置→流水线 创建');
        setBusy(false);
        return;
      }
      api.dispatchPipeline(projectId, { text, defId: effectiveDefId })
        .then((r) => {
          toast.success(`已建 issue #${r.issueNumber}，流水线开跑`);
          onRunStarted(r.runId);
        })
        .catch((e) => {
          toast.error(String(e instanceof Error ? e.message : e));
          setBusy(false);
        });
      return;
    }

    const eff = effort === 'default' ? undefined : (effort as Effort);
    const body: Parameters<typeof api.spawn>[0] = {
      projectId,
      prompt: text || undefined,
      agent,
      ...(model !== DEFAULT_MODEL_VALUE ? { model } : {}),
      effort: eff,
      ...(project?.baseImage && !container ? { container: false as const } : {}),
      ...(advancedMachine ? { machineId: advancedMachine } : {}),
      ...(advancedCwd ? { cwd: advancedCwd } : {}),
    };

    api
      .spawn(body)
      .then((r) => {
        if (r.sessionId) {
          onCreated(r.sessionId);
        } else if (r.queued) {
          toast('无空闲机器，已排队；有资源自动派发');
          setPrompt('');
          setBusy(false);
          invalidate('queued-sessions');
          invalidate('resources');
        }
      })
      .catch((e) => {
        toast.error(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  };

  const cancelQueuedSession = (taskId: string) => {
    if (!projectId || cancellingTaskId) return;
    setCancellingTaskId(taskId);
    api.cancelQueuedSession(projectId, taskId)
      .then(() => {
        toast.success('已取消排队会话');
        invalidate('queued-sessions');
        invalidate('resources');
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
      .finally(() => setCancellingTaskId(null));
  };

  const retryQueuedSession = (taskId: string) => {
    if (!projectId || retryingTaskId) return;
    setRetryingTaskId(taskId);
    api.retryQueuedSession(projectId, taskId)
      .then(() => {
        toast.success('失败会话已重新排队');
        invalidate('queued-sessions');
        invalidate('resources');
      })
      .catch((e) => {
        toast.error(String(e instanceof Error ? e.message : e));
        void refetchQueuedSessions();
      })
      .finally(() => setRetryingTaskId(null));
  };

  const reprioritizeQueuedSession = async (task: QueuedSessionRow) => {
    if (!projectId || updatingPriorityTaskId) return;
    const draft = priorityDrafts[task.id] ?? String(task.priority);
    const priority = Number(draft);
    if (!draft.trim() || !Number.isInteger(priority) || priority < -2_147_483_648 || priority > 2_147_483_647) {
      toast.error('优先级必须是 32 位整数');
      return;
    }

    setUpdatingPriorityTaskId(task.id);
    try {
      await api.reprioritizeQueuedSession(projectId, task.id, priority);
      await refetchQueuedSessions();
      setPriorityDrafts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      toast.success(`优先级已更新为 ${priority}`);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
      void refetchQueuedSessions();
    } finally {
      setUpdatingPriorityTaskId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const canSubmit = prompt.trim().length > 0 && !busy && !!projectId;

  return (
    <div className="flex min-h-full flex-1 items-center justify-center">
      <div className="w-full max-w-2xl px-6 -mt-12">
        {/* 项目名（浅色小字） */}
        <p className="mb-1.5 text-center text-[11px] text-faint">
          {project?.name ?? '未选择项目'}
        </p>

        {/* 问候标题 */}
        <h1 className="mb-7 text-center font-display text-2xl font-semibold tracking-tight text-ink">
          要做什么？
        </h1>

        {!projectId ? (
          <p className="text-center text-xs text-dim">请先在左上选择项目</p>
        ) : (
          <>
            {/* 输入框 */}
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={prompt}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                rows={2}
                placeholder={pipeline ? '描述需求，发送后将建 issue 并启动流水线' : '描述你要做的，Enter 发送'}
                disabled={busy}
                className="min-h-[64px] resize-none overflow-hidden rounded-xl py-3.5 pl-4 pr-14 text-sm leading-relaxed shadow-[var(--shadow-panel)]"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="absolute right-3 bottom-3 flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink transition-all hover:bg-accent-2 disabled:opacity-30"
              >
                <SendHorizonal size={14} />
              </button>
            </div>

            {/* Chips 行 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* CLI ▾ */}
              <ChipSelect value={agent} onValueChange={(v) => setAgent(v as SessionAgent)} options={agentOptions} />
              {/* 模型 ▾ */}
              <ChipSelect value={model} onValueChange={setModel} groups={modelGroups} />
              {/* effort ▾ */}
              <ChipSelect value={effort} onValueChange={setEffort} options={effortOptions} />
              {/* 容器 toggle：仅 baseImage 项目显示 */}
              {project?.baseImage && (
                <ChipToggle value={container} onChange={setContainer}>
                  容器
                </ChipToggle>
              )}
              {/* 走流水线：真建 issue → 项目流水线开跑（与 issue 自动触发同一条路） */}
              {onRunStarted && (
                pipelines.length > 0 ? (
                  <ChipToggle value={pipeline} onChange={setPipeline}>
                    走流水线
                  </ChipToggle>
                ) : (
                  <span
                    className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-line/40 bg-bg-2/40 px-2.5 py-0.5 text-[11px] text-faint"
                    title="项目还没有流水线——去 项目设置→流水线 创建"
                  >
                    走流水线
                  </span>
                )
              )}
              {/* 流水线选择：开了走流水线且有多条时出现 */}
              {pipeline && pipelines.length > 1 && (
                <ChipSelect
                  value={effectiveDefId}
                  onValueChange={setPipelineDefId}
                  options={pipelines.map((d) => ({ value: d.id, label: d.name.slice(0, 24) }))}
                />
              )}
              {/* 高级 ▾ */}
              <div className="relative" ref={advancedRef}>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium outline-none transition-all active:scale-[0.97] cursor-pointer',
                    showAdvanced || advancedMachine || advancedCwd
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-line/70 bg-bg-2/60 text-dim hover:border-accent/40',
                  )}
                >
                  高级
                  <ChevronDown
                    size={11}
                    className={cn('transition-transform', showAdvanced && 'rotate-180')}
                  />
                </button>
                {showAdvanced && (
                  <div className="absolute right-0 top-full z-50 mt-1.5 flex w-64 flex-col gap-3 rounded-lg border border-line bg-panel-2 p-3 shadow-xl">
                    {/* 机器 */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-medium tracking-wider text-faint uppercase">机器</span>
                      <select
                        value={advancedMachine}
                        onChange={(e) => setAdvancedMachine(e.target.value)}
                        className="h-7 rounded-md border border-line bg-bg-2/60 px-2 text-[12px] text-ink outline-none focus:border-accent/60"
                      >
                        <option value="">自动</option>
                        {machines.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} {m.labels.length > 0 ? `[${m.labels.join(',')}]` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* 目录 */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-medium tracking-wider text-faint uppercase">工作目录</span>
                      {container && project?.baseImage ? (
                        <span className="text-[11px] italic text-faint">容器内恒为 /workspace</span>
                      ) : (
                        <Input
                          value={advancedCwd}
                          onChange={(e) => setAdvancedCwd(e.target.value)}
                          placeholder="自动（按项目物化）"
                          className="h-7 text-[12px]"
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 资源一览：谁有空闲加速器、排队多少——免 ssh 找机器 */}
            {resources && (resources.machines.some((m) => m.accels.length > 0) || resources.queued > 0) && (
              <div className="mono-nums mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-faint">
                {resources.machines.filter((m) => m.accels.length > 0).map((m) => {
                  const total = m.accels.reduce((n, a) => n + a.total, 0);
                  const free = Math.max(0, total - m.used);
                  const kinds = m.accels.map((a) => a.kind).join('/');
                  return (
                    <span key={m.id} className="inline-flex items-center gap-1.5">
                      <span className={free > 0 ? 'size-1.5 rounded-full bg-ok' : 'size-1.5 rounded-full bg-warn'} />
                      {m.id} · {kinds} 空闲 {free}/{total}
                    </span>
                  );
                })}
                {resources.queued > 0 && <span className="text-warn">排队 {resources.queued}</span>}
              </div>
            )}

            {/* 当前项目可操作的资源队列：pending 可改优先级/取消，failed 可按原参数重试。 */}
            {queuedSessions.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-lg border border-line/70 bg-panel/70 text-left shadow-[var(--shadow-panel)]">
                <div className="border-b border-line/60 px-3 py-2 text-[11px] font-medium text-dim">
                  资源队列 · {queuedSessions.length}
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {queuedSessions.map((task) => {
                    const priorityDraft = priorityDrafts[task.id] ?? String(task.priority);
                    return (
                      <div key={task.id} className="flex items-center gap-3 border-b border-line/40 px-3 py-2 last:border-b-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-ink-2">{task.prompt || '容器会话'}</p>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-faint">
                            <span className={task.status === 'failed' ? 'shrink-0 text-danger' : 'shrink-0 text-warn'}>
                              {task.status === 'failed' ? '派发失败' : '等待资源'}
                            </span>
                            <span className="truncate">
                              {[task.agent, task.model, new Date(task.enqueuedAt).toLocaleString()].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                        </div>
                        {task.status === 'failed' ? (
                          <button
                            type="button"
                            disabled={retryingTaskId !== null}
                            onClick={() => retryQueuedSession(task.id)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                            aria-label={`重试失败的排队会话 ${task.id}`}
                          >
                            <RotateCcw size={12} />
                            {retryingTaskId === task.id ? '重试中…' : '重试'}
                          </button>
                        ) : (
                          <>
                            <form
                              className="flex shrink-0 items-center gap-1"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void reprioritizeQueuedSession(task);
                              }}
                            >
                              <label htmlFor={`queue-priority-${task.id}`} className="text-[10px] text-faint">
                                优先级
                              </label>
                              <input
                                id={`queue-priority-${task.id}`}
                                type="number"
                                min={-2_147_483_648}
                                max={2_147_483_647}
                                step={1}
                                value={priorityDraft}
                                onChange={(event) => setPriorityDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                                className="mono-nums h-7 w-16 rounded-md border border-line bg-bg-2/60 px-1.5 text-right text-[11px] text-ink outline-none focus:border-accent/60"
                              />
                              <button
                                type="submit"
                                disabled={updatingPriorityTaskId !== null || priorityDraft === String(task.priority)}
                                className="rounded-md px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                                aria-label={`更新排队会话 ${task.id} 的优先级`}
                              >
                                {updatingPriorityTaskId === task.id ? '更新中…' : '更新'}
                              </button>
                            </form>
                            <button
                              type="button"
                              disabled={cancellingTaskId !== null}
                              onClick={() => cancelQueuedSession(task.id)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                              aria-label={`取消排队会话 ${task.id}`}
                            >
                              <X size={12} />
                              {cancellingTaskId === task.id ? '取消中…' : '取消'}
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
