import { ChevronDown, SendHorizonal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type Effort } from './api';
import { Input, Textarea } from './components/ui/primitives';
import * as SelectPrimitive from '@radix-ui/react-select';
import { SelectContent, SelectItem } from './components/ui/select';
import { useLlmEndpoints, useMachines, useProjects } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn } from './lib/utils';

// ─── ChipSelect ───────────────────────────────────────────────────────────────
/** 小圆角 chip 样式的下拉选择器，基于现有 Radix Select Primitive */
function ChipSelect({
  value,
  onValueChange,
  options,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-line/70 bg-bg-2/60 px-2.5 py-0.5 text-[11px] font-medium text-ink-2 outline-none transition-all hover:border-accent/40 hover:bg-accent/5 cursor-pointer',
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown size={11} className="text-faint" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
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
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium outline-none transition-all cursor-pointer',
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
/** ChatGPT 式居中 Composer —— 输入框 + chips + Enter 发送，机器与目录全自动就位 */
export function NewSession({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { data: machines = [] } = useMachines();
  const { data: projects = [] } = useProjects();
  const { data: endpoints = [] } = useLlmEndpoints();
  const { projectId } = useProjectScope();

  const project = projects.find((p) => p.id === projectId);

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude');
  const [effort, setEffort] = useState('default');
  const [container, setContainer] = useState(true);
  const [advancedMachine, setAdvancedMachine] = useState('');
  const [advancedCwd, setAdvancedCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  // 模型选项：内建别名 + 自定义 LLM 端点
  const modelOptions = [
    { value: 'claude', label: 'claude' },
    { value: 'deepseek', label: 'deepseek' },
    { value: 'glm', label: 'glm' },
    ...endpoints.map((e) => ({ value: e.label, label: `${e.label}（${e.model}）` })),
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

    const eff = effort === 'default' ? undefined : (effort as Effort);
    const body: Parameters<typeof api.spawn>[0] = {
      projectId,
      prompt: text || undefined,
      model,
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
        }
      })
      .catch((e) => {
        toast.error(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const canSubmit = prompt.trim().length > 0 && !busy && !!projectId;

  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="w-full max-w-xl px-4 -mt-12">
        {/* 项目名（浅色小字） */}
        <p className="mb-1 text-center text-[11px] text-faint">
          {project?.name ?? '未选择项目'}
        </p>

        {/* 问候标题 */}
        <h1 className="mb-6 text-center text-lg font-semibold tracking-tight text-ink">
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
                rows={1}
                placeholder="在这里输入，Enter 发送，Shift+Enter 换行"
                disabled={busy}
                className="resize-none overflow-hidden pr-12 text-sm leading-relaxed"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-md bg-accent text-accent-ink transition-all hover:bg-accent-2 disabled:opacity-30"
              >
                <SendHorizonal size={14} />
              </button>
            </div>

            {/* Chips 行 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* 模型 ▾ */}
              <ChipSelect value={model} onValueChange={setModel} options={modelOptions} />
              {/* effort ▾ */}
              <ChipSelect value={effort} onValueChange={setEffort} options={effortOptions} />
              {/* 容器 toggle：仅 baseImage 项目显示 */}
              {project?.baseImage && (
                <ChipToggle value={container} onChange={setContainer}>
                  容器
                </ChipToggle>
              )}
              {/* 高级 ▾ */}
              <div className="relative" ref={advancedRef}>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium outline-none transition-all cursor-pointer',
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
          </>
        )}
      </div>
    </div>
  );
}
