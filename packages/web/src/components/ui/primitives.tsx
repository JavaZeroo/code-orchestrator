/** 轻量 UI 原语集合：Input / Textarea / Badge / StatusDot / Card / Label / Spinner */

import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

const fieldBase =
  'w-full rounded-md border border-line bg-bg-2/60 text-[13px] text-ink outline-none transition-all placeholder:text-faint focus:border-accent/60 focus:bg-bg-2 focus:ring-2 focus:ring-accent/15';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldBase, 'h-8 px-2.5', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, 'px-2.5 py-2 leading-relaxed', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

const badgeTones = {
  neutral: 'border-line/80 bg-panel-2 text-dim',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  ok: 'border-ok/35 bg-ok/10 text-ok',
  run: 'border-run/35 bg-run/10 text-run',
  warn: 'border-warn/35 bg-warn/10 text-warn',
  danger: 'border-danger/35 bg-danger/10 text-danger',
  info: 'border-info/35 bg-info/10 text-info',
  human: 'border-human/35 bg-human/10 text-human',
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

const dotTones: Record<string, string> = {
  neutral: 'text-faint',
  accent: 'text-accent',
  ok: 'text-ok',
  run: 'text-run',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  human: 'text-human',
};

/** 状态圆点：live 时心跳脉冲（呼应"活着的仪表盘"） */
export function StatusDot({ tone = 'neutral', live = false, className }: { tone?: string; live?: boolean; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full bg-current', dotTones[tone] ?? 'text-faint', live && 'live-dot', className)}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('surface shadow-[var(--shadow-panel)]', className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('flex flex-col gap-1.5 text-xs font-medium text-dim', className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-line border-t-accent', className)}
    />
  );
}
