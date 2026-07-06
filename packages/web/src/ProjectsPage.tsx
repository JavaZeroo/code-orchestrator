/** 项目页：per-场景策略容器。核心是每个项目的「自治开关」(manual/agent/auto)——控制权在你。 */

import { Cpu, FolderGit2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, type Autonomy, type ForgeKind, type ProjectRow } from './api';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useProjects } from './lib/queries';
import { cn } from './lib/utils';

const FORGE_LABEL: Record<ForgeKind, string> = { gitcode: 'GitCode', github: 'GitHub' };

const AUTONOMY: { id: Autonomy; label: string; tone: string; desc: string }[] = [
  { id: 'manual', label: '手动', tone: 'neutral', desc: '每个 PR 你审你合 —— 系统只把绿灯 PR 送到你的合并门。' },
  { id: 'agent', label: 'Agent 判断', tone: 'info', desc: '在护栏内由 agent 判断是否需要你介入；碰护栏路径一律留人工。' },
  { id: 'auto', label: '全自动', tone: 'accent', desc: 'CI 绿 + 评审 LGTM + 未碰护栏 → 自动合并 + 健康门部署 + 失败自动回滚。' },
];

function AutonomySwitch({ value, onChange }: { value: Autonomy; onChange: (a: Autonomy) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-bg-2/60 p-0.5">
      {AUTONOMY.map((a) => {
        const on = a.id === value;
        return (
          <button
            key={a.id}
            onClick={() => onChange(a.id)}
            className={cn(
              'rounded-md px-3 py-1 text-[12px] font-medium transition-all',
              on
                ? a.id === 'auto'
                  ? 'bg-accent text-accent-ink shadow-[0_2px_10px_-4px_var(--color-accent)]'
                  : a.id === 'agent'
                    ? 'bg-info/20 text-info'
                    : 'bg-panel-3 text-ink'
                : 'text-dim hover:text-ink-2',
            )}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectRow }) {
  const setAutonomy = (autonomy: Autonomy) => {
    api
      .patchProject(p.id, { autonomy })
      .then(() => {
        toast.success(`${p.name} → ${AUTONOMY.find((a) => a.id === autonomy)?.label}`);
        invalidate('projects');
      })
      .catch((e) => toast.error(String(e)));
  };
  const remove = () => {
    if (!confirm(`删除项目 ${p.name}？（其触发器会解绑，不删）`)) return;
    api.deleteProject(p.id).then(() => invalidate('projects')).catch((e) => toast.error(String(e)));
  };
  const mode = AUTONOMY.find((a) => a.id === p.autonomy)!;

  return (
    <Card className="flex flex-col gap-3.5 p-4 transition-colors hover:border-line-2">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-accent">
          <FolderGit2 size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-display text-[15px] font-semibold text-ink">{p.name}</h3>
            <Badge tone="neutral">{FORGE_LABEL[p.forge]}</Badge>
          </div>
          <div className="mono-nums mt-0.5 truncate text-[11px] text-faint">{p.repo}</div>
        </div>
        <Button variant="ghost" size="icon-sm" className="text-faint hover:text-danger" onClick={remove} title="删除">
          <Trash2 size={14} />
        </Button>
      </div>

      <div className="rounded-lg border border-line bg-bg-2/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-wide text-dim uppercase">自治开关</span>
          <AutonomySwitch value={p.autonomy} onChange={setAutonomy} />
        </div>
        <p className={cn('text-[12px] leading-relaxed', p.autonomy === 'auto' ? 'text-accent/90' : 'text-dim')}>{mode.desc}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-dim">
        {Object.keys(p.models).length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Cpu size={12} className="text-faint" />
            {(['pm', 'dev', 'se'] as const).filter((k) => p.models[k]).map((k) => (
              <span key={k} className="mono-nums rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">
                {k}:{p.models[k]}
              </span>
            ))}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <ShieldCheck size={12} className={cn(p.guardrails.length ? 'text-ok' : 'text-faint')} />
          护栏 {p.guardrails.length} 条
        </span>
      </div>
    </Card>
  );
}

function CreateProject({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [forge, setForge] = useState<ForgeKind>('github');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    setBusy(true);
    api
      .createProject({ name: name.trim(), forge, repo: repo.trim(), autonomy: 'manual' })
      .then(() => {
        toast.success('项目已创建（自治=手动，可随时拨开关）');
        setName('');
        setRepo('');
        setOpen(false);
        onDone();
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <Button variant="default" onClick={() => setOpen(true)}>
        <Plus size={15} /> 新建项目
      </Button>
    );
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Label>
          名称
          <Input value={name} placeholder="mindformers" onChange={(e) => setName(e.target.value)} />
        </Label>
        <Label>
          代码托管
          <Select value={forge} onValueChange={(v) => setForge(v as ForgeKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="gitcode">GitCode</SelectItem>
            </SelectContent>
          </Select>
        </Label>
      </div>
      <Label>
        仓库（owner/repo）
        <Input value={repo} placeholder="owner/repo" onChange={(e) => setRepo(e.target.value)} />
      </Label>
      <p className="text-[11px] text-faint">新项目默认「手动」——建好后按需拨到 Agent / 全自动。</p>
      <div className="flex gap-2">
        <Button variant="default" disabled={busy || !name.trim() || !repo.trim()} onClick={create}>
          {busy ? '创建中…' : '创建'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </Card>
  );
}

export function ProjectsPage() {
  const { data: projects = [], isLoading } = useProjects();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-dim">
            每个项目一份策略包 —— <span className="text-ink-2">自治开关在你手里</span>：管自己可全自动，管关键项目可全手动。
          </p>
        </div>
        <CreateProject onDone={() => invalidate('projects')} />
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-sm text-faint">加载中…</div>
      ) : projects.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <FolderGit2 size={28} className="text-faint" />
          <p className="text-sm text-dim">还没有项目 —— 新建一个来承载它的开发策略。</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
