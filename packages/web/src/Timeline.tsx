import { ChevronRight, FileEdit, Paperclip, Terminal, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApprovalRequest, EventRow, SessionEnvelope } from './api';
import { Markdown } from './components/Markdown';
import { TextDiff } from './components/DiffView';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/primitives';
import { cn } from './lib/utils';

const fmtHm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
};

export interface ApprovalItem {
  request: ApprovalRequest;
  status: 'pending' | 'approved' | 'denied';
}

interface ToolCall {
  call: string;
  name: string;
  args: Record<string, unknown>;
  done: boolean;
  output?: string;
  isError?: boolean;
}

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start max-w-[85%] border-l-2 border-line/40 pl-2">
      <button className="flex items-center gap-1 text-[11px] text-dim" onClick={() => setOpen(v => !v)}>
        <ChevronRight size={11} className={cn('transition-transform', open && 'rotate-90')} />
        思考 · {text.length} 字
      </button>
      {open && <div className="mt-1 opacity-60 italic"><Markdown text={text} /></div>}
    </div>
  );
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
          {!tool.done ? (
            <Badge tone="run" className="!py-0">运行中</Badge>
          ) : tool.isError ? (
            <Badge tone="danger" className="!py-0">失败</Badge>
          ) : (
            <Badge tone="ok" className="!py-0">完成</Badge>
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
          {tool.output && (
            <pre
              className={cn(
                'mt-2 max-h-72 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs',
                tool.isError ? 'text-danger' : 'text-ink-2',
              )}
            >
              {tool.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (id: string, b: 'allow' | 'deny') => void }) {
  const { request, status } = item;
  const payload = request.payload as Record<string, unknown>;
  const input = (payload.input ?? payload) as Record<string, unknown>;
  const toolName =
    typeof payload.toolName === 'string'
      ? payload.toolName
      : typeof payload.name === 'string'
        ? payload.name
        : undefined;
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
      {toolName === 'Bash' || typeof input.command === 'string' ? (
        <pre className="mb-2 max-h-52 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-ink-2">
          {String(input.command ?? '')}
        </pre>
      ) : (toolName === 'Edit' || toolName === 'MultiEdit') &&
        typeof input.old_string === 'string' &&
        typeof input.new_string === 'string' ? (
        <div className="mb-2"><TextDiff oldText={input.old_string} newText={input.new_string} /></div>
      ) : toolName === 'Write' && typeof input.content === 'string' ? (
        <pre className="mb-2 max-h-52 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-ink-2">
          {input.content}
        </pre>
      ) : (
        <pre className="mb-2 max-h-52 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-dim">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
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
          if (ev.thinking) {
            out.push({ key: String(row.seq), el: <ThinkingBubble text={ev.text} /> });
          } else {
            out.push({
              key: String(row.seq),
              el: (
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl border px-3.5 py-2.5',
                    env.role === 'user'
                      ? 'self-end border-accent/30 bg-accent/10'
                      : 'self-start border-line bg-panel',
                  )}
                >
                  {env.role === 'user' ? <div className="whitespace-pre-wrap">{ev.text}</div> : <Markdown text={ev.text} />}
                </div>
              ),
            });
          }
        } else if (ev.t === 'tool-call-start') {
          const tool: ToolCall = { call: ev.call, name: ev.name, args: ev.args, done: false };
          tools.set(ev.call, tool);
          out.push({ key: `tool-${ev.call}`, el: null });
        } else if (ev.t === 'tool-call-end') {
          const t = tools.get(ev.call);
          if (t) {
            t.done = true;
            t.output = ev.output;
            t.isError = ev.isError;
          }
        } else if (ev.t === 'service') {
          out.push({
            key: String(row.seq),
            el: <div className="self-center text-xs text-warn">{ev.text}</div>,
          });
        } else if (ev.t === 'turn-start') {
          out.push({ key: String(row.seq), el: (
            <div className="my-1 flex items-center gap-2 self-stretch text-[10px] text-faint">
              <div className="h-px flex-1 border-t border-dashed border-line/60" />
              {env.time ? <span className="mono-nums">{fmtHm(env.time)}</span> : null}
              <div className="h-px flex-1 border-t border-dashed border-line/60" />
            </div>
          )});
        } else if (ev.t === 'file') {
          out.push({ key: String(row.seq), el: (
            <div className="self-start inline-flex items-center gap-2 rounded-lg border border-line bg-panel/60 px-3 py-2 text-sm">
              <Paperclip size={13} className="shrink-0 text-dim" />
              <span className="font-medium">{ev.name}</span>
              <span className="text-xs text-dim">{fmtBytes(ev.size)}</span>
            </div>
          )});
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
