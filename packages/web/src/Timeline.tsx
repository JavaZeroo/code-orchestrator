import type { ApprovalRequest, EventRow, SessionEnvelope } from './api';

export interface ApprovalItem {
  request: ApprovalRequest;
  status: 'pending' | 'approved' | 'denied';
}

interface Props {
  events: EventRow[];
  approvals: Map<string, ApprovalItem>;
  onDecide: (approvalId: string, behavior: 'allow' | 'deny') => void;
}

function Envelope({ envelope }: { envelope: SessionEnvelope }) {
  const ev = envelope.ev;
  switch (ev.t) {
    case 'text':
      return (
        <div className={`bubble ${envelope.role}${ev.thinking ? ' thinking' : ''}`}>
          {ev.thinking ? <span className="tag">思考</span> : null}
          <pre>{ev.text}</pre>
        </div>
      );
    case 'tool-call-start':
      return (
        <details className="tool">
          <summary>
            🔧 {ev.name} <span className="dim">#{ev.call.slice(-6)}</span>
          </summary>
          <pre>{JSON.stringify(ev.args, null, 2)}</pre>
        </details>
      );
    case 'tool-call-end':
      return <div className="sys">✓ 工具完成 <span className="dim">#{ev.call.slice(-6)}</span></div>;
    case 'turn-start':
      return <div className="divider" />;
    case 'turn-end':
      return <div className={`sys turn-end ${ev.status}`}>— 回合{ev.status === 'completed' ? '完成' : ev.status === 'cancelled' ? '取消' : '失败'} —</div>;
    case 'start':
      return <div className="sys">会话已启动</div>;
    case 'stop':
      return <div className="sys">会话已终止</div>;
    case 'service':
      return <div className="sys warn">{ev.text}</div>;
    default:
      return null;
  }
}

function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: Props['onDecide'] }) {
  const { request, status } = item;
  return (
    <div className={`approval ${status}`}>
      <div className="approval-head">
        <span className="tag">审批</span> <b>{request.title}</b>
        {status !== 'pending' && <span className={`chip ${status}`}>{status === 'approved' ? '已批准' : '已拒绝'}</span>}
      </div>
      <pre>{JSON.stringify(request.payload, null, 2)}</pre>
      {status === 'pending' && (
        <div className="approval-actions">
          <button className="allow" onClick={() => onDecide(request.id, 'allow')}>
            批准
          </button>
          <button className="deny" onClick={() => onDecide(request.id, 'deny')}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

export function Timeline({ events, approvals, onDecide }: Props) {
  return (
    <div className="timeline">
      {events.map((row) => {
        if (row.type === 'session.message') {
          return <Envelope key={row.seq} envelope={row.payload as SessionEnvelope} />;
        }
        if (row.type === 'approval.requested') {
          const request = row.payload as ApprovalRequest;
          const item = approvals.get(request.id) ?? { request, status: 'pending' as const };
          return <ApprovalCard key={row.seq} item={item} onDecide={onDecide} />;
        }
        return null;
      })}
    </div>
  );
}
