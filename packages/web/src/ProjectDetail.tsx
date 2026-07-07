/**
 * 项目详情页（#37）：概览 / 自动化 / 流程模板 三区竖排。
 * 内容从 ProjectsPage（概览）、TriggersPage（自动化）、WorkflowsPage（模板）搬迁。
 */

import { Archive, ArchiveRestore, ChevronDown, ExternalLink, MessageCircle, Play, Plus, RefreshCw, Rocket, Star, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { CreateTriggerBody, ForgeKind, ProjectRow, RequirementRow, TriggerRow, WorkflowDefRow } from './api';
import { api } from './api';
import type { Me } from './Auth';
import { Designer } from './Designer';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label, Spinner, Textarea, type BadgeTone } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useRequirements, useTriggers, useWorkflows } from './lib/queries';
import { cn, relTime } from './lib/utils';
import { AutonomySwitch } from './ProjectsPage';
import { useCurrentProject } from './lib/project';

/* ──────── 自动化：触发器相关子组件（从 TriggersPage 搬迁） ──────── */

const FORGE_LABEL: Record<ForgeKind, string> = { gitcode: 'GitCode', github: 'GitHub' };

const REQ_TONE: Record<string, BadgeTone> = {
  running: 'accent',
  waiting_human: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return out;
}

function CreateTriggerForm({ me, projectId }: { me: Me; projectId: string }) {
  const { data: allWorkflows = [] } = useWorkflows();
  const workflows = allWorkflows.filter((w) => w.projectId === projectId);
  const [forge, setForge] = useState<ForgeKind>('github');
  const [repo, setRepo] = useState('');
  const [defId, setDefId] = useState('');
  const [labels, setLabels] = useState('');
  const [titlePattern, setTitlePattern] = useState('');
  const [varsText, setVarsText] = useState('');
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);

  const bound = me.forges[forge]?.bound;

  const create = () => {
    const body: CreateTriggerBody = {
      projectId,
      forge,
      repo: repo.trim(),
      defId,
      labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
      titlePattern: titlePattern.trim() || undefined,
      vars: parseVars(varsText),
      backfill: backfill ? 'yes' : 'no',
    };
    setBusy(true);
    api
      .createTrigger(body)
      .then(() => {
        toast.success('触发器已创建');
        setRepo('');
        setLabels('');
        setTitlePattern('');
        setVarsText('');
        setBackfill(false);
        invalidate('triggers');
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Plus size={15} className="text-accent" />
        <h3 className="text-sm font-semibold">新建触发器</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
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
        <Label>
          仓库（owner/repo）
          <Input value={repo} placeholder="JavaZeroo/code-orchestrator" onChange={(e) => setRepo(e.target.value)} />
        </Label>
      </div>
      {!bound && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
          {FORGE_LABEL[forge]} 尚未在「设置」绑定令牌——触发器可创建，但轮询需要一个已绑定的令牌才能读取 issue。
        </p>
      )}
      <Label>
        目标工作流
        <Select value={defId} onValueChange={setDefId}>
          <SelectTrigger>
            <SelectValue placeholder="选择命中后要启动的工作流" />
          </SelectTrigger>
          <SelectContent>
            {workflows.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <Label>
          标签过滤（逗号分隔，需全含）
          <Input value={labels} placeholder="需求, enhancement" onChange={(e) => setLabels(e.target.value)} />
        </Label>
        <Label>
          标题过滤（正则，可空）
          <Input value={titlePattern} placeholder="^\\[需求\\]" onChange={(e) => setTitlePattern(e.target.value)} />
        </Label>
      </div>
      <Label>
        附加变量（每行 key=value，与 issue_* 变量合并注入工作流）
        <Textarea
          rows={2}
          value={varsText}
          placeholder={'cwd=/root/work/repo\nbase=main'}
          onChange={(e) => setVarsText(e.target.value)}
        />
      </Label>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-dim">
        <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} className="accent-accent" />
        对现存 open issue 也触发（默认关闭：首次只建立基线，之后的新 issue 才触发）
      </label>
      <Button variant="default" className="self-start" disabled={busy || !repo.trim() || !defId} onClick={create}>
        {busy ? '创建中…' : '创建触发器'}
      </Button>
    </Card>
  );
}

function TriggerRowItem({ t }: { t: TriggerRow }) {
  const [busy, setBusy] = useState(false);
  const on = t.enabled === 'yes';

  const toggle = () => {
    setBusy(true);
    api
      .patchTrigger(t.id, { enabled: on ? 'no' : 'yes' })
      .then(() => invalidate('triggers'))
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };
  const remove = () => {
    if (!confirm(`删除触发器 ${t.repo}？（关联的需求记录一并删除）`)) return;
    api.deleteTrigger(t.id).then(() => invalidate('triggers')).catch((e) => toast.error(String(e)));
  };

  return (
    <div className="flex items-start gap-3 border-b border-line/60 px-3 py-2.5 last:border-b-0">
      <button
        onClick={toggle}
        disabled={busy}
        title={on ? '点击停用' : '点击启用'}
        className={cn('mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors', on ? 'bg-ok/80' : 'bg-line')}
      >
        <span className={cn('block size-4 rounded-full bg-white transition-transform', on && 'translate-x-4')} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{FORGE_LABEL[t.forge]}</Badge>
          <span className="truncate text-sm font-medium">{t.repo}</span>
          <span className="text-dim">→</span>
          <span className="truncate text-sm text-accent">{t.defName ?? t.defId}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dim">
          {t.labels.length > 0 && <span>标签: {t.labels.join(', ')}</span>}
          {t.titlePattern && <span>标题: /{t.titlePattern}/</span>}
          {Object.keys(t.vars).length > 0 && <span>变量: {Object.keys(t.vars).join(', ')}</span>}
          {t.backfill === 'yes' && <span className="text-warn">含存量 issue</span>}
          <span>{t.intakeCount > 0 ? `命中 ${t.intakeCount} 条 · 最近 ${relTime(t.lastIntakeAt!)}` : '命中 0 条'}</span>
          <span>{t.lastPolledAt ? `上次轮询 ${relTime(t.lastPolledAt)}` : '尚未轮询'}</span>
        </div>
      </div>
      <Button variant="ghost" size="icon" className="text-danger" title="删除" onClick={remove}>
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function RequirementRowItem({ r, onOpenRun }: { r: RequirementRow; onOpenRun: (runId: string) => void }) {
  const statusText =
    r.status === 'seeded'
      ? '基线（未触发）'
      : r.status === 'failed'
        ? '触发失败'
        : (r.runStatus ?? 'started');
  const tone = r.status === 'seeded' ? 'neutral' : r.status === 'failed' ? 'danger' : REQ_TONE[r.runStatus ?? ''] ?? 'accent';

  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{r.title ?? `#${r.issueNumber}`}</span>
          {r.issueUrl && (
            <a href={r.issueUrl} target="_blank" rel="noreferrer" className="shrink-0 text-dim hover:text-accent" title="打开 issue">
              <ExternalLink size={12} />
            </a>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-dim">
          <span>
            {FORGE_LABEL[r.forge]} {r.repo}#{r.issueNumber}
          </span>
          {r.author && <span>· {r.author}</span>}
          <span>· {relTime(r.createdAt)}</span>
        </div>
      </div>
      <Badge tone={tone}>{statusText}</Badge>
      {r.runId && (
        <Button variant="ghost" size="sm" onClick={() => onOpenRun(r.runId!)} title="查看运行">
          <Play size={13} /> 运行
        </Button>
      )}
    </div>
  );
}

/* ──────── 流程模板卡片 ──────── */

function WorkflowDefCard({ def, project }: { def: WorkflowDefRow; project: ProjectRow }) {
  const [archiving, setArchiving] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const isDefault = project.defaultWorkflow === def.id;

  const doArchive = () => {
    setArchiving(true);
    api.patchWorkflow(def.id, { archived: 'yes' })
      .then(() => { toast.success('已归档'); invalidate('workflows'); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setArchiving(false));
  };

  const doSetDefault = () => {
    setSettingDefault(true);
    api.patchProject(project.id, { defaultWorkflow: def.id })
      .then(() => { toast.success('已设为默认模板'); invalidate('projects'); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setSettingDefault(false));
  };

  return (
    <Card key={def.id} className="p-3.5 transition-colors hover:border-line-2">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-accent">
          <WorkflowIcon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate font-display text-[14px] font-semibold text-ink">
            {def.name}
            {isDefault && <span className="mono-nums rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok">默认</span>}
          </span>
          <span className="mono-nums block text-[11px] text-faint">
            {def.graph.nodes.length} 节点 · v{def.version} · {def.createdVia === 'chat' ? '对话生成' : '手工'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" disabled={settingDefault || isDefault} onClick={doSetDefault} title="设为默认">
            <Star size={13} className={isDefault ? 'fill-ok text-ok' : ''} />
          </Button>
          <Button variant="ghost" size="icon" disabled={archiving} onClick={doArchive} title="归档">
            <Archive size={13} />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ArchivedDefsSection({ defs, project }: { defs: WorkflowDefRow[]; project: ProjectRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        className="flex items-center gap-1.5 self-start px-1 text-xs text-faint hover:text-accent"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-0', !open && '-rotate-90')} />
        已归档模板（{defs.length}）
      </button>
      {open && defs.map((d) => (
        <ArchivedDefCard key={d.id} def={d} />
      ))}
    </div>
  );
}

function ArchivedDefCard({ def }: { def: WorkflowDefRow }) {
  const [restoring, setRestoring] = useState(false);
  const doRestore = () => {
    setRestoring(true);
    api.patchWorkflow(def.id, { archived: 'no' })
      .then(() => { toast.success('已恢复'); invalidate('workflows'); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setRestoring(false));
  };
  return (
    <Card className="p-3 opacity-60 transition-opacity hover:opacity-100">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-faint">
          <Archive size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink line-through decoration-faint/40">{def.name}</span>
          <span className="mono-nums block text-[11px] text-faint">
            {def.graph.nodes.length} 节点 · v{def.version}
          </span>
        </div>
        <Button variant="ghost" size="sm" disabled={restoring} onClick={doRestore}>
          <ArchiveRestore size={13} /> 恢复
        </Button>
      </div>
    </Card>
  );
}

/* ──────── ProjectDetail ──────── */

export function ProjectDetail({
  project,
  me,
  onBack,
  onOpenSession,
  onOpenRun,
}: {
  project: ProjectRow;
  me: Me;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { setProjectId } = useCurrentProject();
  const [view, setView] = useState<'detail' | 'designer'>('detail');
  const { data: allDefs = [] } = useWorkflows();
  const { data: allTriggers = [], isLoading: tLoading } = useTriggers();
  const { data: allRequirements = [], isLoading: rLoading } = useRequirements();

  // 按项目过滤
  const defs = allDefs.filter((d) => d.projectId === project.id);
  const triggers = allTriggers.filter((t) => t.projectId === project.id);
  const requirements = allRequirements.filter((r) => r.projectId === project.id);
  const [polling, setPolling] = useState(false);

  const pollNow = () => {
    setPolling(true);
    api
      .pollTriggers()
      .then((d) => {
        toast.success(`已轮询 ${d.polled} 个触发器`);
        invalidate('requirements');
        invalidate('triggers');
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setPolling(false));
  };

  const setAutonomy = (autonomy: typeof project.autonomy) => {
    api
      .patchProject(project.id, { autonomy })
      .then(() => {
        toast.success(`自治已设为 ${autonomy}`);
        invalidate('projects');
      })
      .catch((e) => toast.error(String(e)));
  };

  if (view === 'designer') {
    return <Designer onBack={() => setView('detail')} onSaved={() => setView('detail')} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* 返回 + 标题 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← 返回项目列表
        </Button>
        <h1 className="truncate font-display text-[16px] font-semibold text-ink">{project.name}</h1>
        <Badge tone="neutral">{project.forge === 'gitcode' ? 'GitCode' : 'GitHub'}</Badge>
        <span className="mono-nums hidden truncate text-[11px] text-faint sm:inline">{project.repo}</span>
      </div>

      {/* ── 概览 ── */}
      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold text-ink-2">概览</h2>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-wide text-dim uppercase">自治开关</span>
          <AutonomySwitch value={project.autonomy} onChange={setAutonomy} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-dim">
          {Object.keys(project.models).length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              {(['pm', 'dev', 'se'] as const).filter((k) => project.models[k]).map((k) => (
                <span key={k} className="mono-nums rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">
                  {k}:{project.models[k]}
                </span>
              ))}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            护栏 {project.guardrails.length} 条
          </span>
        </div>
        {project.baseImage ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
              <span className="mono-nums truncate" title={project.baseImage}>{project.baseImage}</span>
              {project.accel && <Badge tone="run">{project.accel.kind}</Badge>}
            </span>
            <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setProjectId(project.id); onOpenSession('new'); }}>
              <Rocket size={13} /> 启动容器会话
            </Button>
          </div>
        ) : null}
      </Card>

      {/* ── 自动化 ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-2">自动化</h2>
          <Button variant="secondary" size="sm" className="shrink-0" disabled={polling} onClick={pollNow}>
            <RefreshCw size={13} className={cn(polling && 'animate-spin')} /> 立即轮询
          </Button>
        </div>
        <p className="text-xs text-dim">
          issue 满足条件 → 自动起工作流。
          <span className="text-ink-2"> seeded/failed 基线在这里查看</span>——它们是配置域诊断日志，不进任务树。
        </p>
        <CreateTriggerForm me={me} projectId={project.id} />

        <h3 className="pt-2 text-xs font-semibold text-dim">
          触发器 {triggers.length > 0 && <span className="text-dim/70">({triggers.length})</span>}
        </h3>
        <Card className="overflow-hidden p-0">
          {tLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-dim">
              <Spinner /> 加载中…
            </div>
          ) : triggers.length === 0 ? (
            <p className="p-6 text-center text-sm text-dim">还没有触发器。新建一个，让 issue 自动驱动工作流。</p>
          ) : (
            triggers.map((t) => <TriggerRowItem key={t.id} t={t} />)
          )}
        </Card>

        <h3 className="pt-2 text-xs font-semibold text-dim">
          需求列表 {requirements.length > 0 && <span className="text-dim/70">({requirements.length})</span>}
        </h3>
        <Card className="overflow-hidden p-0">
          {rLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-dim">
              <Spinner /> 加载中…
            </div>
          ) : requirements.length === 0 ? (
            <p className="p-6 text-center text-sm text-dim">暂无命中的需求。</p>
          ) : (
            requirements.map((r) => <RequirementRowItem key={r.id} r={r} onOpenRun={onOpenRun} />)
          )}
        </Card>
      </section>

      {/* ── 流程模板 ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink-2">流程模板</h2>
        <div className="flex items-center justify-between">
          <p className="text-xs text-dim">当前项目的流程定义。启动改由「任务」tab 操作。</p>
          <Button variant="default" size="sm" className="shrink-0" onClick={() => setView('designer')}>
            <MessageCircle size={14} /> 对话式新建
          </Button>
        </div>
        {(() => {
          const activeDefs = defs.filter((d) => d.archived !== 'yes');
          const archivedDefs = defs.filter((d) => d.archived === 'yes');
          return (
            <div className="flex flex-col gap-2">
              {activeDefs.length === 0 && archivedDefs.length === 0 ? (
                <Card className="flex flex-col items-center gap-2 py-8 text-center">
                  <WorkflowIcon size={24} className="text-faint" />
                  <p className="text-sm text-dim">还没有工作流 —— 点「对话式新建」，跟 agent 说你要什么流程。</p>
                </Card>
              ) : (
                <>
                  {activeDefs.map((d) => (
                    <WorkflowDefCard key={d.id} def={d} project={project} />
                  ))}
                  {archivedDefs.length > 0 && <ArchivedDefsSection defs={archivedDefs} project={project} />}
                </>
              )}
            </div>
          );
        })()}
      </section>
    </div>
  );
}
