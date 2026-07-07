/**
 * 任务 tab（#37）：血缘树展示、内嵌 RunView、新建任务弹窗、实时刷新。
 * 消费 GET /api/work?projectId=<id>，project 类型根节点自动提升 children。
 */

import { ChevronDown, ExternalLink, FileText, GitPullRequest, ListTree, MessageSquareText, Plus, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { WorkItem, WorkflowDefRow } from './api';
import { api } from './api';
import { RunView } from './RunView';
import { StartForm } from './components/StartForm';
import { Button } from './components/ui/button';
import { Badge, Card, type BadgeTone, StatusDot } from './components/ui/primitives';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useWork, useWorkflows } from './lib/queries';
import { useProjectScope } from './lib/project';
import { cn, relTime } from './lib/utils';

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
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-panel-2',
          depth > 0 && 'ml-5',
        )}
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

export function TasksPage({
  onOpenSession,
  openRunId,
  onOpenRunConsumed,
}: {
  onOpenSession: (id: string) => void;
  openRunId?: string | null;
  onOpenRunConsumed?: () => void;
}) {
  const [view, setView] = useState<'tree' | { run: string }>(openRunId ? { run: openRunId } : 'tree');
  const { projectId } = useProjectScope();
  const { data, isLoading } = useWork(projectId);
  const { data: allDefs = [] } = useWorkflows();
  const [showNew, setShowNew] = useState(false);
  const [selDefId, setSelDefId] = useState('');

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
  if (typeof view === 'object') {
    return <RunView runId={view.run} onOpenSession={onOpenSession} onBack={() => setView('tree')} />;
  }

  // unwrap project roots → requirement（从 project 下提升）+ 手动 run
  const roots = (data?.tree ?? []).flatMap((r) => (r.type === 'project' ? r.children : [r]));
  // 按 updatedAt desc
  roots.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const defs = allDefs.filter((d) => {
    if (!projectId) return true;
    return d.projectId === projectId;
  });
  const selDef = defs.find((d) => d.id === selDefId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-dim">
          本项目的任务血缘树 —— <span className="text-ink-2">从需求到运行到审批</span>，可追溯每次触发的完整链路。
        </p>
        <Button variant="default" size="sm" className="shrink-0" onClick={() => { setSelDefId(''); setShowNew(true); }}>
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

      {/* 新建任务弹窗 */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogTitle>新建任务</DialogTitle>
          <div className="flex flex-col gap-3">
            <p className="text-xs text-dim">选择流程模板，填好变量后启动。第③期会换成对话优先入口。</p>
            <div>
              <label className="mb-1 block text-xs font-medium text-dim">模板</label>
              <Select value={selDefId} onValueChange={setSelDefId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模板" />
                </SelectTrigger>
                <SelectContent>
                  {defs.map((d) => (
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
                onStarted={(runId) => {
                  setShowNew(false);
                  setView({ run: runId });
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
