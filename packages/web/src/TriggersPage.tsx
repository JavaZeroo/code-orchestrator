/**
 * 需求录入触发器页（task #22）：配置「某 forge repo 的 issue 满足条件 → 自动起工作流」，
 * 并展示需求列表（命中 issue → run 追溯）。最初愿景的入口。
 */

import { ExternalLink, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { CreateTriggerBody, ForgeKind, RequirementRow, TriggerRow } from './api';
import { api } from './api';
import type { Me } from './Auth';
import { Button } from './components/ui/button';
import { Badge, Card, Input, Label, Spinner, Textarea } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useRequirements, useTriggers, useWorkflows } from './lib/queries';
import { cn, relTime } from './lib/utils';

const FORGE_LABEL: Record<ForgeKind, string> = { gitcode: 'GitCode', github: 'GitHub' };

const REQ_TONE: Record<string, 'accent' | 'warn' | 'ok' | 'danger' | 'neutral'> = {
  running: 'accent',
  waiting_human: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

/** 每行 `key=value` 解析为静态附加变量 */
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

function CreateTriggerForm({ me }: { me: Me }) {
  const { data: workflows = [] } = useWorkflows();
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

export function TriggersPage({ me, onOpenRun }: { me: Me; onOpenRun: (runId: string) => void }) {
  const { data: triggers = [], isLoading: tLoading } = useTriggers();
  const { data: requirements = [], isLoading: rLoading } = useRequirements();
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 overflow-y-auto p-5">
      <div className="flex items-center gap-2">
        <Zap size={18} className="text-accent" />
        <h2 className="text-lg font-semibold">需求录入触发器</h2>
        <p className="text-xs text-dim">issue 进来 → 自动起工作流</p>
        <Button variant="secondary" size="sm" className="ml-auto" disabled={polling} onClick={pollNow}>
          <RefreshCw size={13} className={cn(polling && 'animate-spin')} /> 立即轮询
        </Button>
      </div>

      <CreateTriggerForm me={me} />

      <div>
        <h3 className="mb-2 text-sm font-semibold text-dim">
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
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-dim">
          需求列表 {requirements.length > 0 && <span className="text-dim/70">({requirements.length})</span>}
        </h3>
        <Card className="overflow-hidden p-0">
          {rLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-dim">
              <Spinner /> 加载中…
            </div>
          ) : requirements.length === 0 ? (
            <p className="p-6 text-center text-sm text-dim">暂无命中的需求。触发器轮询到匹配 issue 后会在这里出现。</p>
          ) : (
            requirements.map((r) => <RequirementRowItem key={r.id} r={r} onOpenRun={onOpenRun} />)
          )}
        </Card>
      </div>
    </div>
  );
}
