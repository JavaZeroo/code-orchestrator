import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './Timeline';

describe('ApprovalCard', () => {
  it('renders Codex questions as answer controls instead of a generic approval', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        item={{
          status: 'pending',
          request: {
            id: 'input-1',
            kind: 'tool',
            sessionId: 'session-1',
            title: 'Scope',
            requestedAt: 1,
            payload: {
              backend: 'codex',
              method: 'item/tool/requestUserInput',
              params: {
                questions: [
                  {
                    id: 'scope',
                    header: 'Scope',
                    question: 'Which area should be changed?',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: 'Runner', description: 'Only update the runner package.' }],
                  },
                ],
              },
            },
          },
        }}
        onDecide={vi.fn()}
        onAnswer={vi.fn()}
      />,
    );

    expect(html).toContain('Which area should be changed?');
    expect(html).toContain('Runner');
    expect(html).toContain('Only update the runner package.');
    expect(html).toContain('type="text"');
    expect(html).toContain('提交回答');
    expect(html).toContain('忽略');
  });
});
