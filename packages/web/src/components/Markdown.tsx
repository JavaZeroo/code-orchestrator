import { Check, Copy } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** shiki 单例（按需懒加载，代码分包） */
let highlighterPromise: Promise<(code: string, lang: string) => string> | null = null;

function getHighlighter() {
  highlighterPromise ??= import('shiki').then(async (shiki) => {
    const h = await shiki.createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'javascript', 'python', 'bash', 'json', 'yaml', 'diff', 'markdown', 'sql', 'tsx'],
    });
    return (code: string, lang: string) => {
      const known = h.getLoadedLanguages().includes(lang) ? lang : 'text';
      return h.codeToHtml(code, { lang: known, theme: 'github-dark' });
    };
  });
  return highlighterPromise;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`rounded p-1 text-dim opacity-0 transition-opacity group-hover:opacity-100 hover:bg-panel-2 hover:text-ink ${className ?? ''}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="复制"
    >
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getHighlighter().then((hl) => {
      if (!cancelled) {
        setHtml(hl(code, lang));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="group relative">
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        {lang !== 'text' && <span className="text-[10px] text-dim/70">{lang}</span>}
        <CopyButton text={code} />
      </div>
      {html ? (
        // shiki 输出的受控 HTML（本地高亮生成，无用户注入面）
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className, node, ...rest } = props;
            const match = /language-(\w+)/.exec(className ?? '');
            const inline = !match && !String(children).includes('\n');
            if (inline) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return <CodeBlock code={String(children).replace(/\n$/, '')} lang={match?.[1] ?? 'text'} />;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
