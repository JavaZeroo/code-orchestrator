/** 轻量 UI 原语集合：Input / Textarea / Badge / Card / Label / Spinner */

import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm outline-none transition-colors placeholder:text-dim/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/40',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-line bg-bg px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-dim/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/40',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

const badgeTones = {
  neutral: 'border-line text-dim',
  accent: 'border-accent/50 text-accent',
  ok: 'border-ok/50 text-ok',
  warn: 'border-warn/50 text-warn',
  danger: 'border-danger/50 text-danger',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-line bg-panel', className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('flex flex-col gap-1.5 text-xs text-dim', className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-line border-t-accent', className)}
    />
  );
}
