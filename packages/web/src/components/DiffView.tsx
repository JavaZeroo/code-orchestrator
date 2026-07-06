import { diffLines } from 'diff';
import { useMemo } from 'react';
import { cn } from '../lib/utils';

/** old/new 文本对比（Edit 工具参数用） */
export function TextDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 font-mono text-xs leading-relaxed">
      {parts.map((p, i) => (
        <span
          key={i}
          className={cn(
            'block whitespace-pre-wrap',
            p.added && 'bg-ok/10 text-ok',
            p.removed && 'bg-danger/10 text-danger line-through/0',
          )}
        >
          {p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line, j) => (
              <span key={j} className="block">
                {p.added ? '+ ' : p.removed ? '- ' : '  '}
                {line}
              </span>
            ))}
        </span>
      ))}
    </pre>
  );
}

/** unified diff 文本着色（git diff 输出用） */
export function UnifiedDiff({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <span
          key={i}
          className={cn(
            'block whitespace-pre-wrap',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-ok/10 text-ok',
            line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
            line.startsWith('@@') && 'text-accent',
            (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) &&
              'text-dim',
          )}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}
