import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApprovalRequest, type MachineRow, type SessionRow } from './api';
import { Timeline, type ApprovalItem } from './Timeline';
import { useSessionEvents } from './useEvents';

const STATE_LABEL: Record<string, string> = {
  starting: '启动中',
  idle: '空闲',
  thinking: '思考中',
  waiting_input: '等待输入',
  waiting_approval: '等待审批',
  dead: '已结束',
};

export function SessionView({ session }: { session: SessionRow }) {
  const events = useSessionEvents(session.id);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [machine, setMachine] = useState<MachineRow | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .machines()
      .then((ms) => setMachine(ms.find((m) => m.id === session.machineId) ?? null))
      .catch(() => {});
  }, [session.machineId]);

  const state = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const row = events[i];
      if (row?.type === 'session.state') {
        return (row.payload as { state: string }).state;
      }
    }
    return session.state;
  }, [events, session.state]);

  const approvals = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    for (const row of events) {
      if (row.type === 'approval.requested') {
        const request = row.payload as ApprovalRequest;
        map.set(request.id, { request, status: 'pending' });
      } else if (row.type === 'approval.decided') {
        const p = row.payload as { approvalId: string; status: 'approved' | 'denied' };
        const existing = map.get(p.approvalId);
        if (existing) {
          map.set(p.approvalId, { ...existing, status: p.status });
        }
      }
    }
    return map;
  }, [events]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const dead = state === 'dead';

  const doSend = () => {
    const t = text.trim();
    if (!t || dead) {
      return;
    }
    setText('');
    api.send(session.id, t).catch((e) => setError(String(e)));
  };

  const doDecide = (approvalId: string, behavior: 'allow' | 'deny') => {
    api.decide(approvalId, behavior).catch((e) => setError(String(e)));
  };

  return (
    <div className="session-view">
      <header>
        <div>
          <b>{session.cwd}</b>
          <span className="dim">
            {' '}@ {session.machineId} · {session.model ?? 'claude'} · {session.id.slice(0, 8)}
          </span>
        </div>
        <div className="header-actions">
          {machine?.codeServerUrl && (
            <a
              className="chip"
              href={`${machine.codeServerUrl}/?folder=${encodeURIComponent(session.cwd)}`}
              target="_blank"
              rel="noreferrer"
            >
              ⌨ 编辑器
            </a>
          )}
          <span className={`chip state-${state}`}>{STATE_LABEL[state] ?? state}</span>
          {!dead && (
            <button className="deny" onClick={() => void api.kill(session.id).catch((e) => setError(String(e)))}>
              终止
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}（点击关闭）
        </div>
      )}
      <Timeline events={events} approvals={approvals} onDecide={doDecide} />
      <div ref={bottomRef} />
      <footer>
        <textarea
          value={text}
          placeholder={dead ? '会话已结束' : '输入消息，Enter 发送，Shift+Enter 换行'}
          disabled={dead}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <button onClick={doSend} disabled={dead || !text.trim()}>
          发送
        </button>
      </footer>
    </div>
  );
}
