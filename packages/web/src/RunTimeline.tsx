import { ArrowDown, ChevronRight, ExternalLink, GitBranch, RefreshCw, Send, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApprovalRequest, EventRow, ForgeRefRow, NodeStateRow, RunRow, SessionEnvelope, WorkflowDefRow, WorkflowDef } from './api';
import { api } from './api';
import { foldSessionEvents, type ApprovalItem } from './Timeline';
import { Markdown } from './components/Markdown';
import { Button } from './components/ui/button';
import { Badge, StatusDot, Textarea, type BadgeTone } from './components/ui/primitives';
import { cn } from './lib/utils';

// ---- 复用常量（与 FlowGraph / RunView 同源）----

const TYPE_ICON: Record<string, string> = {
  agent: '\u{1F916}',
  gate: '\u{1F6A7}',
  meeting: '\u{1F5F3}',
  fanout: '\u{2163}',
  condition: '?',
};

const NODE_TONE: Record<string, BadgeTone> = {
  running: 'run',
  waiting_human: 'human',
  done: 'ok',
  failed: 'danger',
  pending: 'neutral',
  skipped: 'neutral',
};

const RUN_META: Record<string, { label: string; tone: BadgeTone; live?: boolean }> = {
  running: { label: '运行中', tone: 'run', live: true },
  waiting_human: { label: '等待审批', tone: 'human' },
  paused: { label: '已暂停', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  waiting_human: '等待审批',
  done: '已完成',
  failed: '失败',
  pending: '等待中',
  skipped: '已跳过',
};

// ---- 工具函数 ----

function forgePrUrl(forge: string, repo: string, number: number): string {
  if (forge === 'github') return `https://github.com/${repo}/pull/${number}`;
  return `https://gitcode.com/${repo}/merge_requests/${number}`;
}

/** 判一段 session.message events 是否含 tool-call（用于折叠判据） */
function hasToolCall(events: EventRow[]): boolean {
  for (const row of events) {
    if (row.type === 'session.message') {
      const env = row.payload as SessionEnvelope;
      if (env.ev.t === 'tool-call-start' || env.ev.t === 'tool-call-end') return true;
    }
  }
  return false;
}

/** 从 tool-call-start 提取摘要文本 */
function toolSummary(events: EventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]!;
    if (row.type === 'session.message') {
      const env = row.payload as SessionEnvelope;
      if (env.ev.t === 'tool-call-start') {
        const args = env.ev.args as Record<string, unknown> | undefined;
        if (typeof args?.file_path === 'string') return `正在编辑 ${args.file_path}`;
        if (typeof args?.command === 'string') return `正在执行 ${args.command.slice(0, 60)}`;
        return `工具调用：${env.ev.name}`;
      }
    }
  }
  return null;
}

// ---- 子组件 ----

/** 节点来源标识条 */
function NodeHeader({ nodeId, title, type, model, status }: {
  nodeId: string; title?: string; type?: string; model?: string | null; status?: string;
}) {
  return (
    <div className="flex items-center gap-2 self-stretch border-b border-line/40 pb-1.5 mb-1">
      <span className="text-sm">{TYPE_ICON[type ?? 'agent'] ?? '\u{1F4E6}'}</span>
      <span className="font-medium text-sm text-ink">{title ?? nodeId}</span>
      {model && <span className="mono-nums rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-accent/80">{model}</span>}
      {status && <Badge tone={NODE_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>}
    </div>
  );
}

/** 节点活动卡（默认折叠含 tool-call 的段） */
function ActivityCard({ events, expanded, onToggle }: {
  events: EventRow[]; expanded: boolean; onToggle: () => void;
}) {
  const toolCount = useMemo(() => {
    let n = 0;
    for (const row of events) {
      if (row.type === 'session.message') {
        const env = row.payload as SessionEnvelope;
        if (env.ev.t === 'tool-call-start') n++;
      }
    }
    return n;
  }, [events]);

  const summary = useMemo(() => toolSummary(events), [events]);

  return (
    <div className="self-stretch rounded-lg border border-line bg-panel/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={onToggle}
      >
        <ChevronRight size={13} className={cn('shrink-0 text-dim transition-transform', expanded && 'rotate-90')} />
        <Wrench size={13} className="shrink-0 text-accent" />
        <span className="font-medium">
          {summary ?? `活动中 · ${toolCount} 次工具调用`}
        </span>
        <span className="ml-auto shrink-0">
          <Badge tone="neutral" className="!py-0">展开详情</Badge>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-line">
          {foldSessionEvents(events).map((it) => (
            it.el && <div key={it.key} className="flex flex-col">{it.el}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 状态卡：run.node.state */
function StatusCard({ nodeId, status, title, type, model }: {
  nodeId: string; status: string; title?: string; type?: string; model?: string | null;
}) {
  const tone = NODE_TONE[status] ?? 'neutral';
  return (
    <div className={cn(
      'self-stretch rounded-lg border px-3 py-2',
      tone === 'run' && 'border-run/30 bg-run/5',
      tone === 'ok' && 'border-ok/30 bg-ok/5 opacity-80',
      tone === 'danger' && 'border-danger/30 bg-danger/5 opacity-80',
      tone === 'human' && 'border-human/30 bg-human/5',
      tone === 'neutral' && 'border-line/60 bg-panel/40 opacity-70',
    )}>
      <div className="flex items-center gap-2">
        <span className="text-sm">{TYPE_ICON[type ?? 'agent'] ?? '\u{1F4E6}'}</span>
        <span className="font-medium text-sm">{title ?? nodeId}</span>
        {model && <span className="mono-nums text-[10px] text-dim">{model}</span>}
        <span className="ml-auto">
          <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>
        </span>
      </div>
    </div>
  );
}

export type ForgeRetestState = 'idle' | 'posting' | 'pending';

export function isForgeRetestEligible(forgeRef: ForgeRefRow): boolean {
  return Boolean(forgeRef.id) && forgeRef.forge === 'gitcode' && forgeRef.kind === 'pr' && forgeRef.active === 'yes';
}

/** PR·CI 状态卡 */
export function ForgeCard({ forgeRef, prState, ciState, retestState = 'idle', onRetest }: {
  forgeRef: ForgeRefRow;
  prState?: string;
  ciState?: string;
  retestState?: ForgeRetestState;
  onRetest?: () => void;
}) {
  const url = forgePrUrl(forgeRef.forge, forgeRef.repo, forgeRef.number);
  const ciLabel = ciState === 'passed' ? '✔ CI 已过'
    : ciState === 'failed' ? '✖ CI 失败'
    : ciState === 'running' ? '● CI 运行中'
    : ciState === 'pending' ? '○ CI 等待中'
    : null;
  const ciTone: BadgeTone = ciState === 'passed' ? 'ok' : ciState === 'failed' ? 'danger' : ciState === 'running' ? 'run' : 'neutral';
  const canRetest = Boolean(onRetest) && isForgeRetestEligible(forgeRef);
  const retestLabel = retestState === 'posting' ? '发送中…' : retestState === 'pending' ? '等待 CI 确认' : '重跑 CI';

  return (
    <div className="self-stretch rounded-lg border border-line bg-panel/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-dim" />
        <span className="font-medium text-sm">{forgeRef.forge}#{forgeRef.number}</span>
        {prState && <Badge tone="neutral">{prState}</Badge>}
        {ciLabel && <Badge tone={ciTone}>{ciLabel}</Badge>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {canRetest && (
            <Button variant="outline" size="sm" disabled={retestState !== 'idle'} onClick={onRetest}>
              <RefreshCw size={11} className={retestState === 'posting' ? 'animate-spin' : undefined} />
              {retestLabel}
            </Button>
          )}
          <a href={url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline flex items-center gap-1">
            <ExternalLink size={11} /> PR
          </a>
        </div>
      </div>
    </div>
  );
}

/** Gate 审批卡（带按钮） */
function GateCard({ item, onDecide }: { item: ApprovalItem; onDecide: (id: string, b: 'allow' | 'deny') => void }) {
  const { request, status, decidedBy } = item;

  return (
    <div className={cn(
      'self-stretch rounded-lg border p-3',
      status === 'pending' && 'border-warn/50 bg-warn/5',
      status === 'approved' && 'border-ok/40 bg-ok/5 opacity-80',
      status === 'denied' && 'border-danger/40 bg-danger/5 opacity-80',
    )}>
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="warn">审批</Badge>
        <b className="text-sm">{request.title}</b>
        {status === 'approved' && <Badge tone="ok">已批准</Badge>}
        {status === 'denied' && <Badge tone="danger">已拒绝</Badge>}
      </div>
      {status !== 'pending' && decidedBy && (
        <div className="text-xs text-dim mb-2">决策人：{decidedBy}</div>
      )}
      {status === 'pending' && (
        <div className="flex gap-2">
          <Button variant="success" size="sm" onClick={() => onDecide(request.id, 'allow')}>批准</Button>
          <Button variant="danger" size="sm" onClick={() => onDecide(request.id, 'deny')}>拒绝</Button>
        </div>
      )}
    </div>
  );
}

// ---- 主组件 ----

interface RunTimelineProps {
  events: EventRow[];
  nodes: NodeStateRow[];
  def: WorkflowDefRow;
  run: RunRow;
  forgeRefs: ForgeRefRow[];
  /** 当前活跃节点会话 id（用于插话），null 表示无活跃节点 */
  activeSessionId: string | null;
  onSend: (text: string) => void;
  onDecide: (id: string, b: 'allow' | 'deny') => void;
  onRetest: (refId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}

interface RetestProgress {
  phase: Exclude<ForgeRetestState, 'idle'>;
  baselineCiStatus: string | null;
}

export function RunTimeline({ events, nodes, def, run, forgeRefs, activeSessionId, onSend, onDecide, onRetest, onOpenSession }: RunTimelineProps) {
  const [text, setText] = useState('');
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const [retestProgress, setRetestProgress] = useState<Record<string, RetestProgress>>({});
  const retestLocks = useRef(new Set<string>());
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const NEAR_BOTTOM = 80;

  // 会话→节点 映射
  const nodeBySession = useMemo(() => {
    const map = new Map<string, NodeStateRow>();
    for (const n of nodes) {
      if (n.sessionId) map.set(n.sessionId, n);
    }
    return map;
  }, [nodes]);

  // 节点 id→定义 映射（def 标题里的 {{vars.x}} 模板用本 run 变量插值）
  const nodeDefById = useMemo(() => {
    const vars = run.context?.vars ?? {};
    const interp = (t?: string) => t?.replace(/\{\{vars\.([\w.]+)\}\}/g, (_, k: string) => vars[k] ?? '');
    const map = new Map<string, { title?: string; type: string; model?: string }>();
    for (const n of (def.graph as WorkflowDef).nodes) {
      map.set(n.id, { title: interp(n.title), type: n.type, model: (n as Record<string, unknown>).model as string | undefined });
    }
    return map;
  }, [def, run]);

  // forge ref → 最新 ci/pr 状态
  const forgeRefByKey = useMemo(() => {
    const map = new Map<string, ForgeRefRow>();
    for (const fr of forgeRefs) {
      map.set(`${fr.forge}:${fr.repo}:${fr.number}`, fr);
    }
    return map;
  }, [forgeRefs]);

  const handleRetest = useCallback((forgeRef: ForgeRefRow) => {
    if (!isForgeRetestEligible(forgeRef) || retestLocks.current.has(forgeRef.id)) return;
    retestLocks.current.add(forgeRef.id);
    setRetestProgress((prev) => ({
      ...prev,
      [forgeRef.id]: { phase: 'posting', baselineCiStatus: forgeRef.ciStatus },
    }));
    void onRetest(forgeRef.id).then(
      () => {
        setRetestProgress((prev) => ({
          ...prev,
          [forgeRef.id]: { phase: 'pending', baselineCiStatus: forgeRef.ciStatus },
        }));
      },
      () => {
        retestLocks.current.delete(forgeRef.id);
        setRetestProgress((prev) => {
          const next = { ...prev };
          delete next[forgeRef.id];
          return next;
        });
      },
    );
  }, [onRetest]);

  // poller 改变 CI 状态（或停止跟踪）后，解除“等待确认”锁。
  useEffect(() => {
    setRetestProgress((prev) => {
      let next = prev;
      for (const [refId, progress] of Object.entries(prev)) {
        if (progress.phase !== 'pending') continue;
        const ref = forgeRefs.find((candidate) => candidate.id === refId);
        const confirmed = !ref
          || ref.active !== 'yes'
          || (ref.ciStatus !== null && ref.ciStatus !== progress.baselineCiStatus);
        if (!confirmed) continue;
        if (next === prev) next = { ...prev };
        delete next[refId];
        retestLocks.current.delete(refId);
      }
      return next;
    });
  }, [forgeRefs, retestProgress]);

  // 审批状态（从 events 重建）
  const approvals = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    for (const row of events) {
      if (row.type === 'approval.requested') {
        const req = row.payload as ApprovalRequest;
        // 只收集 gate 类型
        if (req.kind === 'gate') {
          map.set(req.id, { request: req, status: 'pending' });
        }
      } else if (row.type === 'approval.decided') {
        const p = row.payload as { approvalId: string; status: 'approved' | 'denied'; decidedBy?: string };
        const ex = map.get(p.approvalId);
        if (ex) map.set(p.approvalId, { ...ex, status: p.status, decidedBy: p.decidedBy });
      }
    }
    return map;
  }, [events]);

  // ---- 构建时间线 ----
  interface TimelineItem {
    key: string;
    seq: number;
    el: React.ReactNode;
  }

  const items = useMemo(() => {
    const out: TimelineItem[] = [];

    // ① 按 sessionId 分组连续 session.message
    let segSessionId: string | null = null;
    let segEvents: EventRow[] = [];

    const flushSegment = () => {
      if (segEvents.length === 0) return;
      const sid = segSessionId;
      const seg = segEvents;
      const firstSeq = seg[0]!.seq;
      const node = sid ? nodeBySession.get(sid) : undefined;
      const nodeDef = node ? nodeDefById.get(node.nodeId) : undefined;
      const isTool = hasToolCall(seg);
      const segKey = `seg-${firstSeq}`;

      if (isTool) {
        const expanded = expandedSegments.has(segKey);
        out.push({
          key: segKey,
          seq: firstSeq,
          el: (
            <div className="flex flex-col gap-2">
              {node && <NodeHeader nodeId={node.nodeId} title={nodeDef?.title} type={nodeDef?.type} model={node.model} status={node.status} />}
              <ActivityCard events={seg} expanded={expanded} onToggle={() => {
                setExpandedSegments((prev) => {
                  const next = new Set(prev);
                  if (expanded) next.delete(segKey);
                  else next.add(segKey);
                  return next;
                });
              }} />
            </div>
          ),
        });
      } else {
        out.push({
          key: segKey,
          seq: firstSeq,
          el: (
            <div className="flex flex-col gap-2">
              {node && <NodeHeader nodeId={node.nodeId} title={nodeDef?.title} type={nodeDef?.type} model={node.model} status={node.status} />}
              {foldSessionEvents(seg).map((it) => (
                it.el && <div key={it.key} className="flex flex-col">{it.el}</div>
              ))}
            </div>
          ),
        });
      }

      segEvents = [];
      segSessionId = null;
    };

    for (const row of events) {
      if (row.type === 'session.message') {
        if (row.sessionId !== segSessionId) {
          flushSegment();
          segSessionId = row.sessionId ?? null;
        }
        segEvents.push(row);
      } else {
        flushSegment();

        if (row.type === 'run.node.state') {
          const p = row.payload as { nodeId: string; status: string };
          const nd = nodeDefById.get(p.nodeId);
          const ns = nodes.find((n) => n.nodeId === p.nodeId);
          out.push({
            key: `ns-${row.seq}`,
            seq: row.seq,
            el: <StatusCard nodeId={p.nodeId} status={p.status} title={nd?.title} type={nd?.type} model={ns?.model} />,
          });
        } else if (row.type === 'forge.ref_registered') {
          const p = row.payload as { forge: string; repo: string; number: number; nodeId?: string };
          const fr = forgeRefByKey.get(`${p.forge}:${p.repo}:${p.number}`);
          out.push({
            key: `fr-${row.seq}`,
            seq: row.seq,
            el: <ForgeCard forgeRef={fr ?? { id: '', forge: p.forge as 'gitcode' | 'github', kind: 'pr', repo: p.repo, number: p.number, runId: run.id, nodeId: p.nodeId ?? null, sessionId: null, ciStatus: null, snapshot: null, active: 'yes' }} retestState={fr ? retestProgress[fr.id]?.phase : undefined} onRetest={fr ? () => handleRetest(fr) : undefined} />,
          });
        } else if (row.type === 'forge.pr_state') {
          const p = row.payload as { forge: string; repo: string; number: number; state: string };
          const fr = forgeRefByKey.get(`${p.forge}:${p.repo}:${p.number}`);
          out.push({
            key: `prs-${row.seq}`,
            seq: row.seq,
            el: <ForgeCard forgeRef={fr ?? { id: '', forge: p.forge as 'gitcode' | 'github', kind: 'pr', repo: p.repo, number: p.number, runId: run.id, nodeId: null, sessionId: null, ciStatus: null, snapshot: null, active: 'yes' }} prState={p.state} retestState={fr ? retestProgress[fr.id]?.phase : undefined} onRetest={fr ? () => handleRetest(fr) : undefined} />,
          });
        } else if (row.type === 'forge.ci') {
          const p = row.payload as { forge: string; repo: string; number: number; state: string };
          const fr = forgeRefByKey.get(`${p.forge}:${p.repo}:${p.number}`);
          out.push({
            key: `ci-${row.seq}`,
            seq: row.seq,
            el: <ForgeCard forgeRef={fr ?? { id: '', forge: p.forge as 'gitcode' | 'github', kind: 'pr', repo: p.repo, number: p.number, runId: run.id, nodeId: null, sessionId: null, ciStatus: null, snapshot: null, active: 'yes' }} ciState={p.state} retestState={fr ? retestProgress[fr.id]?.phase : undefined} onRetest={fr ? () => handleRetest(fr) : undefined} />,
          });
        } else if (row.type === 'forge.conflict') {
          const p = row.payload as { forge: string; repo: string; number: number };
          const fr = forgeRefByKey.get(`${p.forge}:${p.repo}:${p.number}`);
          out.push({
            key: `fc-${row.seq}`,
            seq: row.seq,
            el: (
              <div className="self-stretch rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <GitBranch size={13} className="shrink-0 text-danger" />
                  <span className="text-sm font-medium text-danger">冲突检测：{p.forge}#{p.number}</span>
                  {fr && (
                    <a href={forgePrUrl(fr.forge, fr.repo, fr.number)} target="_blank" rel="noreferrer" className="ml-auto text-xs text-accent hover:underline flex items-center gap-1">
                      <ExternalLink size={11} /> PR
                    </a>
                  )}
                </div>
              </div>
            ),
          });
        } else if (row.type === 'forge.review_comment') {
          const p = row.payload as { forge: string; repo: string; number: number; author?: string; body?: string };
          const fr = forgeRefByKey.get(`${p.forge}:${p.repo}:${p.number}`);
          out.push({
            key: `frc-${row.seq}`,
            seq: row.seq,
            el: (
              <div className="self-stretch rounded-lg border border-line bg-panel/60 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <GitBranch size={13} className="shrink-0 text-dim" />
                  <span className="text-xs font-medium">评审评论：{p.forge}#{p.number}</span>
                  {p.author && <span className="text-xs text-dim">@{p.author}</span>}
                  {fr && (
                    <a href={forgePrUrl(fr.forge, fr.repo, fr.number)} target="_blank" rel="noreferrer" className="ml-auto text-xs text-accent hover:underline flex items-center gap-1">
                      <ExternalLink size={11} /> PR
                    </a>
                  )}
                </div>
                {p.body && <div className="text-xs text-ink-2 max-h-24 overflow-hidden"><Markdown text={p.body.slice(0, 500)} /></div>}
              </div>
            ),
          });
        } else if (row.type === 'approval.requested') {
          const req = row.payload as ApprovalRequest;
          if (req.kind === 'gate') {
            const item = approvals.get(req.id) ?? { request: req, status: 'pending' as const };
            out.push({
              key: `gate-${req.id}`,
              seq: row.seq,
              el: <GateCard item={item} onDecide={onDecide} />,
            });
          }
        } else if (row.type === 'run.started' || row.type === 'run.finished' || row.type === 'run.status') {
          // 隐式——状态迁移由节点状态卡表达
        }
      }
    }
    flushSegment();

    return out.sort((a, b) => a.seq - b.seq);
  }, [events, nodeBySession, nodeDefById, forgeRefByKey, approvals, expandedSegments, nodes, run.id, onDecide, retestProgress, handleRetest]);

  // ---- 智能滚动（仿 SessionView）----

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    atBottomRef.current = near;
    if (near) setShowJump(false);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [events.length]);

  // ---- 发送 ----

  const runMeta = RUN_META[run.status] ?? { label: run.status, tone: 'neutral' as const };
  const isTerminal = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
  const composerDisabled = isTerminal || !activeSessionId;
  const composerPlaceholder = isTerminal
    ? '运行已结束'
    : !activeSessionId
      ? '当前无进行中的节点'
      : '输入消息，Enter 发送，Shift+Enter 换行';

  const doSend = () => {
    const t = text.trim();
    if (!t || composerDisabled || !activeSessionId) return;
    setText('');
    onSend(t);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 时间线区域 */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div className="flex flex-col gap-3 px-4 py-4">
            {items.map((it) => (
              it.el && <div key={it.key} className="flex flex-col">{it.el}</div>
            ))}
          </div>
          <div ref={bottomRef} />
        </div>
        {showJump && (
          <button
            onClick={() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); atBottomRef.current = true; setShowJump(false); }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink shadow-lg hover:bg-bg-2"
          >
            <ArrowDown size={12} /> 新消息
          </button>
        )}
      </div>

      {/* 底部插话 */}
      <footer className="flex gap-2 border-t border-line bg-bg-2/40 px-4 py-3 backdrop-blur-sm">
        <Textarea
          value={text}
          rows={2}
          placeholder={composerPlaceholder}
          disabled={composerDisabled}
          className="resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <Button variant="default" size="icon" className="h-auto w-11 shrink-0" disabled={composerDisabled || !text.trim()} onClick={doSend}>
          <Send size={15} />
        </Button>
      </footer>
    </div>
  );
}
