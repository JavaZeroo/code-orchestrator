import { ChevronRight, FileEdit, Terminal, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApprovalRequest, EventRow, SessionEnvelope } from './api';
import { Markdown } from './components/Markdown';
import { TextDiff } from './components/DiffView';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/primitives';
import { cn } from './lib/utils';

export interface ApprovalItem {
  request: ApprovalRequest;
  status: 'pending' | 'approved' | 'denied';
}

interface ToolCall {
  call: string;
  name: string;
  args: Record<string, unknown>;
  done: boolean;
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isEdit = tool.name === 'Edit' || tool.name === 'MultiEdit';
  const isWrite = tool.name === 'Write';
  const isBash = tool.name === 'Bash';
  const Icon = isBash ? Terminal : isEdit || isWrite ? FileEdit : Wrench;
  const filePath = typeof tool.args.file_path === 'string' ? tool.args.file_path : undefined;
  const subtitle = isBash
    ? String(tool.args.command ?? '')
    : filePath ?? (typeof tool.args.pattern === 'string' ? tool.args.pattern : '');

  return (
    <div className="self-stretch rounded-lg border border-line bg-panel/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={13} className={cn('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
        <Icon size={13} className="shrink-0 text-accent" />
        <span className="font-medium">{tool.name}</span>
        {subtitle && <span className="truncate font-mono text-xs text-dim">{subtitle}</span>}
        <span className="ml-auto shrink-0">
          {tool.done ? (
            <Badge tone="ok" className="!py-0">
              完成
            </Badge>
          ) : (
            <Badge tone="run" className="!py-0">
              运行中
            </Badge>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          {isEdit && typeof tool.args.old_string === 'string' && typeof tool.args.new_string === 'string' ? (
            <TextDiff oldText={tool.args.old_string} newText={tool.args.new_string} />
          ) : isWrite && typeof tool.args.content === 'string' ? (
            <pre className="max-h-72 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-ink-2">
              {tool.args.content}
            </pre>
          ) : (
            <pre className="max-h-72 overflow-auto font-mono text-xs text-dim">
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (id: string, b: 'allow' | 'deny') => void }) {
  const { request, status } = item;
  const input = (request.payload.input ?? request.payload) as Record<string, unknown>;
  return (
    <div
      className={cn(
        'self-stretch rounded-lg border p-3',
        status === 'pending' && 'border-warn/50 bg-warn/5',
        status === 'approved' && 'border-ok/40 bg-ok/5 opacity-80',
        status === 'denied' && 'border-danger/40 bg-danger/5 opacity-80',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="warn">审批</Badge>
        <b className="text-sm">{request.title}</b>
        {status === 'approved' && <Badge tone="ok">已批准</Badge>}
        {status === 'denied' && <Badge tone="danger">已拒绝</Badge>}
      </div>
      <pre className="mb-2 max-h-52 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-dim">
        {JSON.stringify(input, null, 2)}
      </pre>
      {status === 'pending' && (
        <div className="flex gap-2">
          <Button variant="success" size="sm" onClick={() => onDecide(request.id, 'allow')}>
            批准
          </Button>
          <Button variant="danger" size="sm" onClick={() => onDecide(request.id, 'deny')}>
            拒绝
          </Button>
        </div>
      )}
    </div>
  );
}

/** 把事件流折叠成渲染项：文本气泡、合并的工具卡、审批卡、系统行、回合分隔 */
export function Timeline({
  events,
  approvals,
  onDecide,
}: {
  events: EventRow[];
  approvals: Map<string, ApprovalItem>;
  onDecide: (id: string, b: 'allow' | 'deny') => void;
}) {
  const items = useMemo(() => {
    const tools = new Map<string, ToolCall>();
    const out: Array<{ key: string; el: React.ReactNode }> = [];
    for (const row of events) {
      if (row.type === 'session.message') {
        const env = row.payload as SessionEnvelope;
        const ev = env.ev;
        if (ev.t === 'text') {
          out.push({
            key: String(row.seq),
            el: (
              <div
                className={cn(
                  'max-w-[85%] rounded-xl border px-3.5 py-2.5',
                  env.role === 'user'
                    ? 'self-end border-accent/30 bg-accent/10'
                    : cn('self-start border-line bg-panel', ev.thinking && 'opacity-60 italic'),
                )}
              >
                {ev.thinking && <div className="mb-1 text-[11px] text-dim">思考</div>}
                {env.role === 'user' ? <div className="whitespace-pre-wrap">{ev.text}</div> : <Markdown text={ev.text} />}
              </div>
            ),
          });
        } else if (ev.t === 'tool-call-start') {
          const tool: ToolCall = { call: ev.call, name: ev.name, args: ev.args, done: false };
          tools.set(ev.call, tool);
          out.push({ key: `tool-${ev.call}`, el: null });
        } else if (ev.t === 'tool-call-end') {
          const t = tools.get(ev.call);
          if (t) {
            t.done = true;
          }
        } else if (ev.t === 'service') {
          out.push({
            key: String(row.seq),
            el: <div className="self-center text-xs text-warn">{ev.text}</div>,
          });
        } else if (ev.t === 'turn-start') {
          out.push({ key: String(row.seq), el: <div className="my-1 self-stretch border-t border-dashed border-line/60" /> });
        }
      } else if (row.type === 'approval.requested') {
        const req = row.payload as ApprovalRequest;
        const item = approvals.get(req.id) ?? { request: req, status: 'pending' as const };
        out.push({ key: `ap-${req.id}`, el: <ApprovalCard item={item} onDecide={onDecide} /> });
      }
    }
    // 回填工具卡（合并了 start/end 状态）
    return out.map((it) =>
      it.el === null && it.key.startsWith('tool-')
        ? { ...it, el: <ToolCard tool={tools.get(it.key.slice(5))!} /> }
        : it,
    );
  }, [events, approvals, onDecide]);

  return <div className="flex flex-col gap-2.5 px-4 py-4">{items.map((it) => it.el && <div key={it.key} className="flex flex-col">{it.el}</div>)}</div>;
}
