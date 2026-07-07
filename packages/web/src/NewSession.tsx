import { Container, MessageSquarePlus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type Effort } from './api';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label, Textarea } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { useLlmEndpoints, useMachines, useProjectMaterializations, useProjects } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn } from './lib/utils';

export function NewSession({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { data: machines = [] } = useMachines();
  const { data: projects = [] } = useProjects();
  const { data: endpoints = [] } = useLlmEndpoints();
  const { projectId } = useProjectScope();
  const { data: materializations = [] } = useProjectMaterializations(projectId);

  const project = projects.find((p) => p.id === projectId);

  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('/root');
  const [cwdTouched, setCwdTouched] = useState(false);
  const [model, setModel] = useState('claude');
  const [effort, setEffort] = useState('default');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [container, setContainer] = useState(true);

  // 机器默认：dev 优先（同 TasksPage.tsx:308 写法）
  useEffect(() => {
    if (machines.length > 0 && !machineId) {
      setMachineId((machines.find((m) => m.labels?.includes('dev')) ?? machines[0])!.id);
    }
  }, [machines, machineId]);

  // cwd 建议物化目录（非容器模式，用户未手改时）
  useEffect(() => {
    if (container || cwdTouched || !machineId || !projectId) return;
    const readyMat = materializations.find((m) => m.status === 'ready' && m.basePath && m.machineId === machineId);
    if (readyMat?.basePath) {
      setCwd(readyMat.basePath);
    }
  }, [materializations, machineId, projectId, container, cwdTouched]);

  const submit = () => {
    if (!machineId || (!container && !cwd)) {
      return;
    }
    setBusy(true);
    const eff = effort === 'default' ? undefined : (effort as Effort);

    if (container && project?.baseImage) {
      api
        .createContainerSession({ projectId: projectId!, prompt: prompt.trim() || undefined, model, machineId, effort: eff })
        .then((r) => {
          if (r.sessionId) {
            onCreated(r.sessionId);
          } else if (r.queued) {
            toast('无空闲机器，已排队；有资源自动派发');
            setPrompt('');
            setBusy(false);
          }
        })
        .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
        .finally(() => setBusy(false));
    } else {
      api
        .spawn({ machineId, cwd, model, prompt: prompt.trim() || undefined, projectId, effort: eff })
        .then((d) => onCreated(d.sessionId))
        .catch((e) => toast.error(`创建失败：${e}`))
        .finally(() => setBusy(false));
    }
  };

  const hasMat = materializations.some((m) => m.status === 'ready' && m.basePath && m.machineId === machineId);

  return (
    <div className="mx-auto mt-12 flex w-full max-w-lg flex-col gap-4 px-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/5 text-accent">
          <MessageSquarePlus size={19} />
        </div>
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">新建会话</h2>
          <p className="text-[12px] text-dim">在一台在线机器上起一个 agent 会话</p>
        </div>
      </div>

      {/* 项目上下文 */}
      <Card className="flex flex-col gap-1.5 p-4">
        <span className="text-[11px] font-medium text-dim">当前项目</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">{project?.name ?? '未选择项目'}</span>
          {project?.baseImage && (
            <Badge tone="accent">{project.baseImage.split('/').pop()}</Badge>
          )}
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <Label>
          机器
          <Select value={machineId} onValueChange={setMachineId}>
            <SelectTrigger>
              <SelectValue placeholder="选择机器" />
            </SelectTrigger>
            <SelectContent>
              {machines.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} {m.labels.length > 0 ? `[${m.labels.join(',')}]` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>

        {/* 容器模式下隐藏 cwd */}
        {container && project?.baseImage ? null : (
          <Label>
            工作目录
            <Input
              value={cwd}
              onChange={(e) => { setCwd(e.target.value); setCwdTouched(true); }}
              placeholder="/path/to/repo"
            />
            {hasMat && !cwdTouched && (
              <p className="text-[11px] text-faint">已按物化目录建议</p>
            )}
          </Label>
        )}

        <Label>
          模型
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">claude（默认）</SelectItem>
              <SelectItem value="deepseek">deepseek（Anthropic 兼容）</SelectItem>
              <SelectItem value="glm">glm（Anthropic 兼容）</SelectItem>
              {endpoints.map((e) => (
                <SelectItem key={e.id} value={e.label}>{e.label}（{e.model}）</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>

        <Label>
          推理强度
          <Select value={effort} onValueChange={setEffort}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">默认</SelectItem>
              <SelectItem value="low">low</SelectItem>
              <SelectItem value="medium">medium</SelectItem>
              <SelectItem value="high">high</SelectItem>
              <SelectItem value="xhigh">xhigh</SelectItem>
              <SelectItem value="max">max</SelectItem>
            </SelectContent>
          </Select>
        </Label>

        {/* 容器开关：仅 baseImage 项目显示 */}
        {project?.baseImage && (
          <div className="flex items-center justify-between rounded-lg border border-line bg-bg-2/60 p-3">
            <div className="flex items-center gap-2">
              <Container size={14} className="text-accent" />
              <span className="text-xs font-medium text-dim">容器内执行</span>
            </div>
            <div className="inline-flex rounded-lg border border-line bg-bg-2/60 p-0.5">
              <button
                onClick={() => setContainer(true)}
                className={cn(
                  'rounded-md px-3 py-1 text-[12px] font-medium transition-all',
                  container ? 'bg-accent text-accent-ink' : 'text-dim hover:text-ink-2',
                )}
              >
                开
              </button>
              <button
                onClick={() => setContainer(false)}
                className={cn(
                  'rounded-md px-3 py-1 text-[12px] font-medium transition-all',
                  !container ? 'bg-panel-3 text-ink' : 'text-dim hover:text-ink-2',
                )}
              >
                关
              </button>
            </div>
          </div>
        )}

        <Label>
          首条消息（可选）
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="要做什么？"
            className="resize-none"
          />
        </Label>

        <Button variant="default" disabled={busy || !machineId} onClick={submit}>
          <Plus size={14} /> {busy ? '创建中…' : '创建会话'}
        </Button>

        {machines.length === 0 && (
          <p className="text-xs text-warn">没有在线机器——先在目标机器上启动 runner。</p>
        )}
      </Card>
    </div>
  );
}
