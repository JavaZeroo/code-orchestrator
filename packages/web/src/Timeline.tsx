import { ChevronRight, Paperclip } from 'lucide-react';
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
  decidedBy?: string;
}

interface ToolCall {
  call: string;
  name: string;
  args: Record<string, unknown>;
  done: boolean;
  output?: string;
  isError?: boolean;
}

export function ThinkingBubble({ text }: { text: string }) {
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

/** 显示用：把绝对路径按会话 cwd 收敛成相对路径 */
function stripCwd(text: string, cwd?: string): string {
  if (!cwd) return text;
  return text.split(`${cwd}/`).join('').split(cwd).join('.');
}

/** 单行工具调用（Claude Code 风格）：状态点 + 工具名 + 参数摘要，点击展开详情 */
export function ToolRow({ tool, cwd }: { tool: ToolCall; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const isEdit = tool.name === 'Edit' || tool.name === 'MultiEdit';
  const isWrite = tool.name === 'Write';
  const filePath = typeof tool.args.file_path === 'string' ? tool.args.file_path : undefined;
  const rawSubtitle =
    typeof tool.args.command === 'string'
      ? tool.args.command.replace(/\s+/g, ' ')
      : filePath ??
        (typeof tool.args.pattern === 'string'
          ? tool.args.pattern
          : typeof tool.args.description === 'string'
            ? tool.args.description
            : '');
  const subtitle = stripCwd(rawSubtitle, cwd);

  return (
    <div className="self-stretch">
      <button
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-[3px] text-left transition-colors hover:bg-panel/60"
        onClick={() => setOpen((v) => !v)}
        title={rawSubtitle}
      >
        <span
          className={cn(
            'shrink-0 text-[9px] leading-none',
            !tool.done ? 'animate-pulse text-run' : tool.isError ? 'text-danger' : 'text-ok/70',
          )}
        >
          ●
        </span>
        <span className="shrink-0 text-xs font-medium text-ink-2">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">{subtitle}</span>
        {tool.isError && <Badge tone="danger" className="!py-0 shrink-0">失败</Badge>}
        <ChevronRight
          size={12}
          className={cn('shrink-0 text-faint opacity-0 transition-all group-hover:opacity-100', open && 'rotate-90 opacity-100')}
        />
      </button>
      {open && (
        <div className="mt-0.5 mb-1 ml-4 rounded-md border border-line bg-panel/40 px-3 py-2">
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

export function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (id: string, b: 'allow' | 'deny') => void }) {
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
        <pre className="mb-2 max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-ink-2">
          {String(input.command ?? '')}
        </pre>
      ) : (toolName === 'Edit' || toolName === 'MultiEdit') &&
        typeof input.old_string === 'string' &&
        typeof input.new_string === 'string' ? (
        <div className="mb-2"><TextDiff oldText={input.old_string} newText={input.new_string} /></div>
      ) : toolName === 'Write' && typeof input.content === 'string' ? (
        <pre className="mb-2 max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-ink-2">
          {input.content}
        </pre>
      ) : (
        <pre className="mb-2 max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs text-dim">
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

export interface RenderItem {
  key: string;
  el: React.ReactNode;
  /** 来源事件 seq，用于与审批卡等非消息事件合并排序 */
  seq: number;
}

/** 把 session.message 事件折叠成渲染项：文本块、单行工具调用、thinking、file/service/turn 分隔。
 *  不处理 approval.requested —— 由调用方自行合并。 */
export function foldSessionEvents(events: EventRow[], opts?: { cwd?: string }): RenderItem[] {
  const tools = new Map<string, ToolCall>();
  const out: RenderItem[] = [];
  for (const row of events) {
    if (row.type !== 'session.message') continue;
    const env = row.payload as SessionEnvelope;
    const ev = env.ev;
    if (ev.t === 'text') {
      if (ev.thinking) {
        out.push({ key: String(row.seq), seq: row.seq, el: <ThinkingBubble text={ev.text} /> });
      } else if (env.role === 'user') {
        out.push({
          key: String(row.seq),
          seq: row.seq,
          el: (
            <div className="my-1 max-w-[75%] self-end rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-2.5">
              <div className="whitespace-pre-wrap">{ev.text}</div>
            </div>
          ),
        });
      } else {
        // agent 正文：不加气泡框，全宽排版（用满右侧空间，正文才是主角）
        out.push({
          key: String(row.seq),
          seq: row.seq,
          el: (
            <div className="my-1 self-stretch px-1">
              <Markdown text={ev.text} />
            </div>
          ),
        });
      }
    } else if (ev.t === 'tool-call-start') {
      const tool: ToolCall = { call: ev.call, name: ev.name, args: ev.args, done: false };
      tools.set(ev.call, tool);
      out.push({ key: `tool-${ev.call}`, seq: row.seq, el: null as unknown as React.ReactNode });
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
        seq: row.seq,
        el: <div className="self-center text-xs text-warn">{ev.text}</div>,
      });
    } else if (ev.t === 'turn-start') {
      out.push({
        key: String(row.seq),
        seq: row.seq,
        el: (
          <div className="my-1 flex items-center gap-2 self-stretch text-[10px] text-faint">
            <div className="h-px flex-1 border-t border-dashed border-line/60" />
            {env.time ? <span className="mono-nums">{fmtHm(env.time)}</span> : null}
            <div className="h-px flex-1 border-t border-dashed border-line/60" />
          </div>
        ),
      });
    } else if (ev.t === 'file') {
      out.push({
        key: String(row.seq),
        seq: row.seq,
        el: (
          <div className="self-start inline-flex items-center gap-2 rounded-lg border border-line bg-panel/60 px-3 py-2 text-sm">
            <Paperclip size={13} className="shrink-0 text-dim" />
            <span className="font-medium">{ev.name}</span>
            <span className="text-xs text-dim">{fmtBytes(ev.size)}</span>
          </div>
        ),
      });
    }
  }
  // 回填工具行（合并了 start/end 状态）
  return out.map((it) =>
    it.el === null && it.key.startsWith('tool-')
      ? { ...it, el: <ToolRow tool={tools.get(it.key.slice(5))!} cwd={opts?.cwd} /> }
      : it,
  );
}

/** 把事件流折叠成渲染项：文本块、单行工具调用、审批卡、系统行、回合分隔 */
export function Timeline({
  events,
  approvals,
  onDecide,
  cwd,
}: {
  events: EventRow[];
  approvals: Map<string, ApprovalItem>;
  onDecide: (id: string, b: 'allow' | 'deny') => void;
  cwd?: string;
}) {
  const items = useMemo(() => {
    // ① session.message → 折叠的渲染项
    const rendered = foldSessionEvents(events, { cwd });
    // ② 审批卡
    const approvalsItems: RenderItem[] = [];
    for (const row of events) {
      if (row.type === 'approval.requested') {
        const req = row.payload as ApprovalRequest;
        const item = approvals.get(req.id) ?? { request: req, status: 'pending' as const };
        approvalsItems.push({ key: `ap-${req.id}`, seq: row.seq, el: <ApprovalCard item={item} onDecide={onDecide} /> });
      }
    }
    // ③ 合并后按 seq 排序
    return [...rendered, ...approvalsItems].sort((a, b) => a.seq - b.seq);
  }, [events, approvals, onDecide, cwd]);

  return <div className="flex flex-col gap-1 px-4 py-4">{items.map((it) => it.el && <div key={it.key} className="flex flex-col">{it.el}</div>)}</div>;
}
