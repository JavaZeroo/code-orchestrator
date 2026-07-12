import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard, SessionNoteCard, Timeline } from './Timeline';

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

describe('standalone session notes', () => {
  it('renders authored Markdown notes in chronological timeline order', () => {
    const html = renderToStaticMarkup(
      <Timeline
        events={[
          { seq: 2, type: 'session.note', payload: { markdown: '**Handoff** details.', author: 'operator@example.com' } },
          { seq: 1, type: 'session.message', payload: { role: 'assistant', ev: { t: 'text', text: 'Before note' } } },
        ]}
        approvals={new Map()}
        onDecide={vi.fn()}
        onAnswer={vi.fn()}
      />,
    );
    expect(html).toContain('会话备注');
    expect(html).toContain('operator@example.com');
    expect(html).toContain('<strong>Handoff</strong> details.');
    expect(html.indexOf('Before note')).toBeLessThan(html.indexOf('会话备注'));
  });

  it('renders a standalone note card', () => {
    const html = renderToStaticMarkup(
      <SessionNoteCard note={{ markdown: 'Durable context.', author: 'operator@example.com' }} />,
    );
    expect(html).toContain('Durable context.');
  });

  it('folds revisions into the original card while preserving author and position', () => {
    const html = renderToStaticMarkup(
      <Timeline
        events={[
          { seq: 1, type: 'session.note', payload: { markdown: 'Outdated.', author: 'original@example.com' } },
          { seq: 2, type: 'session.message', payload: { role: 'assistant', ev: { t: 'text', text: 'After note' } } },
          { seq: 3, type: 'session.note.updated', payload: { noteId: 1, markdown: '**Corrected.**' } },
        ]}
        approvals={new Map()}
        onDecide={vi.fn()}
        onAnswer={vi.fn()}
        onEditNote={vi.fn()}
      />,
    );
    expect(html).toContain('<strong>Corrected.</strong>');
    expect(html).not.toContain('Outdated.');
    expect(html).toContain('original@example.com');
    expect(html).toContain('编辑');
    expect(html.indexOf('Corrected.')).toBeLessThan(html.indexOf('After note'));
  });
});
