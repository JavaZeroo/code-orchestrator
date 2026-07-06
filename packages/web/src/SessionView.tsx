import { Code2, GitCompare, Send, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type ApprovalRequest, type MachineRow, type SessionRow, type SessionUsage } from './api';
import { UnifiedDiff } from './components/DiffView';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Badge, StatusDot, Textarea, type BadgeTone } from './components/ui/primitives';
import { useSessionEvents } from './useEvents';
import { Timeline, type ApprovalItem } from './Timeline';
import { fmtCost, fmtTokens } from './lib/utils';

const STATE_META: Record<string, { label: string; tone: BadgeTone; live?: boolean }> = {
  starting: { label: '启动中', tone: 'run', live: true },
  idle: { label: '空闲', tone: 'ok' },
  thinking: { label: '思考中', tone: 'run', live: true },
  waiting_input: { label: '等待输入', tone: 'human' },
  waiting_approval: { label: '等待审批', tone: 'human' },
  dead: { label: '已结束', tone: 'neutral' },
};

function CostBadge({ usage }: { usage: SessionUsage }) {
  return (
    <Badge tone="neutral" title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens} · ${usage.turns} 回合`}>
      {fmtCost(usage.costUsd)} · {fmtTokens(usage.inputTokens + usage.outputTokens)} tok
    </Badge>
  );
}

function DiffDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<{ stat?: string; diff?: string; error?: string } | null>(null);
  useEffect(() => {
    if (open) {
      setData(null);
      api.sessionDiff(sessionId).then(setData).catch((e) => setData({ error: String(e) }));
    }
  }, [open, sessionId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogTitle>工作目录变更（git diff）</DialogTitle>
        {!data ? (
          <div className="text-sm text-dim">加载中…</div>
        ) : data.error || !data.diff ? (
          <div className="text-sm text-dim">{data.error ?? '无变更'}</div>
        ) : (
          <>
            {data.stat && <pre className="mb-2 font-mono text-xs text-dim">{data.stat}</pre>}
            <UnifiedDiff diff={data.diff} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SessionView({ session }: { session: SessionRow }) {
  const events = useSessionEvents(session.id);
  const [text, setText] = useState('');
  const [machine, setMachine] = useState<MachineRow | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.machines().then((ms) => setMachine(ms.find((m) => m.id === session.machineId) ?? null)).catch(() => {});
  }, [session.machineId]);

  const { state, usage } = useMemo(() => {
    let st = session.state;
    let us: SessionUsage | null = session.usage;
    for (const row of events) {
      if (row.type === 'session.state') {
        const p = row.payload as { state: string; usage?: SessionUsage };
        st = p.state;
        if (p.usage) {
          us = p.usage;
        }
      }
    }
    return { state: st, usage: us };
  }, [events, session.state, session.usage]);

  const approvals = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    for (const row of events) {
      if (row.type === 'approval.requested') {
        const req = row.payload as ApprovalRequest;
        map.set(req.id, { request: req, status: 'pending' });
      } else if (row.type === 'approval.decided') {
        const p = row.payload as { approvalId: string; status: 'approved' | 'denied' };
        const ex = map.get(p.approvalId);
        if (ex) {
          map.set(p.approvalId, { ...ex, status: p.status });
        }
      }
    }
    return map;
  }, [events]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const dead = state === 'dead';
  const busy = state === 'thinking' || state === 'starting';
  const meta = STATE_META[state] ?? { label: state, tone: 'neutral' as BadgeTone };

  const doSend = () => {
    const t = text.trim();
    if (!t || dead) {
      return;
    }
    setText('');
    api.send(session.id, t).catch((e) => toast.error(`发送失败：${e}`));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={meta.tone} live={meta.live} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-ink">{session.cwd}</div>
            <div className="mono-nums truncate text-[11px] text-faint">
              {session.machineId} · <span className="text-accent/70">{session.model ?? 'claude'}</span> · {session.id.slice(0, 8)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {usage && usage.turns > 0 && <CostBadge usage={usage} />}
          {machine?.codeServerUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`${machine.codeServerUrl}/?folder=${encodeURIComponent(session.cwd)}`, '_blank')}
            >
              <Code2 size={13} /> 编辑器
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setShowDiff(true)}>
            <GitCompare size={13} /> 变更
          </Button>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {busy && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => api.interrupt(session.id).then(() => toast('已打断')).catch((e) => toast.error(String(e)))}
            >
              <Square size={12} /> 打断
            </Button>
          )}
          {!dead && (
            <Button variant="danger" size="sm" onClick={() => void api.kill(session.id).catch((e) => toast.error(String(e)))}>
              <X size={13} /> 终止
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <Timeline events={events} approvals={approvals} onDecide={(id, b) => api.decide(id, b).catch((e) => toast.error(String(e)))} />
        <div ref={bottomRef} />
      </div>

      <footer className="flex gap-2 border-t border-line bg-bg-2/40 px-4 py-3 backdrop-blur-sm">
        <Textarea
          value={text}
          rows={2}
          placeholder={dead ? '会话已结束' : '输入消息，Enter 发送，Shift+Enter 换行'}
          disabled={dead}
          className="resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <Button variant="default" size="icon" className="h-auto w-11 shrink-0" disabled={dead || !text.trim()} onClick={doSend}>
          <Send size={15} />
        </Button>
      </footer>

      <DiffDialog sessionId={session.id} open={showDiff} onOpenChange={setShowDiff} />
    </div>
  );
}
