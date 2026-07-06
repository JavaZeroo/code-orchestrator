/**
 * 通知中心：顶栏铃铛 + 未读角标 + 下拉面板。
 * 全局订阅 /ws/client（不带 sessionId/runId 即全量事件流），累积三类事件：
 *   approval.requested（待审批）/ nudge.sent（门禁回流提醒）/ run.finished（工作流完成）
 * 已读游标（lastReadAt 时间戳）存 localStorage；点击通知跳转到对应会话或运行详情。
 */

import { Bell, BellRing, CheckCircle2, Database, type LucideIcon, RefreshCw, ShieldAlert, XCircle, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EventRow } from './api';
import { Button } from './components/ui/button';
import { cn, relTime } from './lib/utils';

const LAST_READ_KEY = 'co:notifications:lastReadAt';
const MAX_ITEMS = 100;

type NotifType = 'approval.requested' | 'nudge.sent' | 'run.finished' | 'requirement.triggered' | 'run.node.retry' | 'requirement.failed' | 'requirement.seeded';

interface NotificationItem {
  key: string;
  type: NotifType;
  title: string;
  detail?: string;
  sessionId?: string;
  runId?: string;
  receivedAt: number;
  failed?: boolean;
}

/** 全局流的帧比 EventRow 多带 runId */
interface GlobalEventRow extends EventRow {
  runId?: string | null;
}

const RUN_STATUS_LABEL: Record<string, string> = { done: '已完成', failed: '失败', cancelled: '已取消' };

let localSeq = 0;

function toNotification(row: GlobalEventRow): NotificationItem | null {
  const base = {
    key: typeof row.seq === 'number' && row.seq >= 0 ? `seq:${row.seq}` : `local:${++localSeq}`,
    sessionId: row.sessionId ?? undefined,
    runId: row.runId ?? undefined,
    receivedAt: Date.now(),
  };
  if (row.type === 'approval.requested') {
    const p = row.payload as {
      id?: string;
      kind?: string;
      title?: string;
      sessionId?: string;
      runId?: string;
      requestedAt?: number;
    };
    return {
      ...base,
      type: 'approval.requested',
      key: p.id ? `approval:${p.id}` : base.key,
      sessionId: base.sessionId ?? p.sessionId,
      runId: base.runId ?? p.runId,
      receivedAt: typeof p.requestedAt === 'number' ? p.requestedAt : base.receivedAt,
      title: `待审批：${p.title ?? p.kind ?? '未知请求'}`,
      detail: p.kind === 'gate' ? '工作流门禁等待人工确认' : '工具调用等待审批',
    };
  }
  if (row.type === 'nudge.sent') {
    const p = row.payload as { message?: string; kind?: string; attempt?: number };
    return {
      ...base,
      type: 'nudge.sent',
      title: '门禁回流提醒',
      detail: p.message ?? (p.kind ? `${p.kind}（第 ${p.attempt ?? 1} 次）` : undefined),
    };
  }
  if (row.type === 'requirement.triggered') {
    const p = row.payload as { repo?: string; issue?: string; title?: string };
    return {
      ...base,
      type: 'requirement.triggered',
      title: '需求已触发工作流',
      detail: p.title ? `${p.repo ?? ''}#${p.issue ?? ''} ${p.title}`.trim() : p.repo,
    };
  }
  if (row.type === 'run.finished') {
    const p = row.payload as { status?: string };
    return {
      ...base,
      type: 'run.finished',
      title: `工作流${RUN_STATUS_LABEL[p.status ?? ''] ?? p.status ?? '结束'}`,
      detail: base.runId ? `Run ${base.runId.slice(0, 8)}` : undefined,
      failed: p.status === 'failed',
    };
  }
  if (row.type === 'run.node.retry') {
    const p = row.payload as { nodeId: string; attempt: number; max: number; reason?: string; detail?: string };
    return {
      ...base,
      type: 'run.node.retry',
      title: '节点重试中',
      detail: `${p.nodeId} 第 ${p.attempt}/${p.max} 次重试${p.reason ? `：${p.reason}` : ''}`,
    };
  }
  if (row.type === 'requirement.failed') {
    const p = row.payload as { repo?: string; issue?: string; error?: string };
    return {
      ...base,
      type: 'requirement.failed',
      title: '需求触发失败',
      detail: p.error ? `${p.repo ?? ''}#${p.issue ?? ''} ${p.error}`.trim() : undefined,
      failed: true,
    };
  }
  if (row.type === 'requirement.seeded') {
    const p = row.payload as { repo?: string; count?: number };
    return {
      ...base,
      type: 'requirement.seeded',
      title: '触发器基线已建立',
      detail: p.repo ? `${p.repo}（${p.count ?? 0} 条）` : undefined,
    };
  }
  return null;
}

const TYPE_META: Record<NotifType, { icon: LucideIcon; tone: string }> = {
  'approval.requested': { icon: ShieldAlert, tone: 'text-warn' },
  'nudge.sent': { icon: BellRing, tone: 'text-accent' },
  'run.finished': { icon: CheckCircle2, tone: 'text-ok' },
  'requirement.triggered': { icon: Zap, tone: 'text-accent' },
  'run.node.retry': { icon: RefreshCw, tone: 'text-warn' },
  'requirement.failed': { icon: XCircle, tone: 'text-danger' },
  'requirement.seeded': { icon: Database, tone: 'text-ok' },
};

export function NotificationBell({
  onOpenSession,
  onOpenRun,
}: {
  onOpenSession: (sessionId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [lastReadAt, setLastReadAt] = useState<number>(() => Number(localStorage.getItem(LAST_READ_KEY)) || 0);
  // 打开面板时记住旧游标，用于在面板内继续标记"哪些是新来的"
  const [readCursorOnOpen, setReadCursorOnOpen] = useState<number>(() => Number(localStorage.getItem(LAST_READ_KEY)) || 0);
  const rootRef = useRef<HTMLDivElement>(null);

  // 全局 WS 订阅（不带查询参数），断线 3s 自动重连
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let disposed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/client`);
      ws.onmessage = (e) => {
        try {
          const n = toNotification(JSON.parse(e.data as string) as GlobalEventRow);
          if (n) {
            setItems((prev) => (prev.some((x) => x.key === n.key) ? prev : [n, ...prev].slice(0, MAX_ITEMS)));
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!disposed) {
          timer = window.setTimeout(connect, 3000);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  // 点击面板外或 Esc 关闭
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = items.filter((n) => n.receivedAt > lastReadAt).length;

  const toggle = () => {
    if (!open) {
      // 打开即视为已读：推进 localStorage 游标，但保留旧游标用于面板内的"新"标记
      setReadCursorOnOpen(lastReadAt);
      const now = Date.now();
      setLastReadAt(now);
      localStorage.setItem(LAST_READ_KEY, String(now));
    }
    setOpen((v) => !v);
  };

  const jump = (n: NotificationItem) => {
    setOpen(false);
    if (n.sessionId) {
      onOpenSession(n.sessionId);
    } else if (n.runId) {
      onOpenRun(n.runId);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button variant="ghost" size="icon" className="relative" title="通知" onClick={toggle}>
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>
      {open && (
        <div className="surface absolute top-full right-0 z-50 mt-2 w-80 overflow-hidden shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-line bg-bg-2/40 px-3 py-2">
            <span className="font-display text-[13px] font-semibold text-ink">通知</span>
            {items.length > 0 && (
              <button className="cursor-pointer text-xs text-dim transition-colors hover:text-ink" onClick={() => setItems([])}>
                清空
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <p className="p-4 text-center text-sm text-dim">暂无通知</p>}
            {items.map((n) => {
              const meta = TYPE_META[n.type];
              const Icon = n.failed ? XCircle : meta.icon;
              const canJump = Boolean(n.sessionId || n.runId);
              return (
                <button
                  key={n.key}
                  className={cn(
                    'flex w-full items-start gap-2.5 border-b border-line/60 px-3 py-2.5 text-left transition-colors last:border-b-0',
                    canJump ? 'cursor-pointer hover:bg-panel-2' : 'cursor-default',
                  )}
                  onClick={() => canJump && jump(n)}
                >
                  <Icon size={15} className={cn('mt-0.5 shrink-0', n.failed ? 'text-danger' : meta.tone)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{n.title}</span>
                    {n.detail && <span className="block truncate text-xs text-dim">{n.detail}</span>}
                    <span className="block text-xs text-dim/70">{relTime(new Date(n.receivedAt).toISOString())}</span>
                  </span>
                  {n.receivedAt > readCursorOnOpen && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
