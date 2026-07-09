import { describe, expect, it } from 'vitest';
import { formatLarkEvent, type LarkMessage } from './format';

function card(message: LarkMessage | null) {
  expect(message).not.toBeNull();
  const body = message!.card as {
    header: { title: { content: string }; template: string };
    elements: Array<Record<string, unknown>>;
  };
  return body;
}

function elementText(body: ReturnType<typeof card>) {
  return body.elements.map((el) => String(el.content ?? el.text ?? '')).join('\n');
}

describe('formatLarkEvent', () => {
  it('formats tool approval requests with a console action when baseUrl is configured', () => {
    const body = card(
      formatLarkEvent(
        {
          type: 'approval.requested',
          sessionId: 's1',
          runId: 'run-12345678',
          payload: { id: 'approval-1', kind: 'tool', title: 'Run command' },
        },
        { baseUrl: 'https://co.example' },
      ),
    );

    expect(body.header).toMatchObject({ title: { content: '待审批' }, template: 'orange' });
    expect(elementText(body)).toContain('类型：工具调用');
    expect(elementText(body)).toContain('审批 ID：`approval-1`');
    expect(body.elements.at(-1)).toMatchObject({
      tag: 'action',
      actions: [{ tag: 'button', url: 'https://co.example', type: 'primary' }],
    });
  });

  it('uses run status colors and includes the short and full run ids', () => {
    const done = card(formatLarkEvent({ type: 'run.finished', runId: 'run-abcdefghijk', payload: { status: 'done' } }));
    const failed = card(formatLarkEvent({ type: 'run.finished', runId: 'run-failed', payload: { status: 'failed' } }));
    const cancelled = card(formatLarkEvent({ type: 'run.finished', runId: 'run-cancelled', payload: { status: 'cancelled' } }));

    expect(done.header.template).toBe('green');
    expect(elementText(done)).toContain('Run：`run-abcd`');
    expect(elementText(done)).toContain('完整 Run ID：`run-abcdefghijk`');
    expect(failed.header.template).toBe('red');
    expect(cancelled.header.template).toBe('grey');
  });

  it('formats nudges and requirement trigger notifications', () => {
    const nudge = card(
      formatLarkEvent({
        type: 'nudge.sent',
        sessionId: 's2',
        runId: 'run-nudge',
        payload: { message: 'please check CI', attempt: 2 },
      }),
    );
    const triggered = card(
      formatLarkEvent({
        type: 'requirement.triggered',
        payload: { repo: 'owner/repo', issue: 42, title: 'add tests', triggerId: 'trg-1' },
      }),
    );

    expect(nudge.header.template).toBe('blue');
    expect(elementText(nudge)).toContain('尝试次数：第 2 次');
    expect(triggered.header.template).toBe('turquoise');
    expect(elementText(triggered)).toContain('owner/repo#42 add tests');
    expect(elementText(triggered)).toContain('Trigger ID：`trg-1`');
  });

  it('returns null for events that are not sent to Lark', () => {
    expect(formatLarkEvent({ type: 'machine.online', payload: { id: 'm1' } })).toBeNull();
  });
});
