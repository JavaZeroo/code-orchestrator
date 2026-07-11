import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRow } from './api';
import { isSessionResumable, ResumeAction } from './SessionView';

const session: SessionRow = {
  id: 'session-1',
  machineId: 'runner-1',
  agent: 'claude',
  model: 'claude-sonnet',
  cwd: '/tmp/work',
  title: null,
  state: 'dead',
  nativeSessionId: 'native-1',
  runId: null,
  nodeId: null,
  projectId: null,
  containerId: null,
  usage: null,
  createdAt: '2026-07-11T00:00:00Z',
};

describe('SessionView resume action', () => {
  it('shows resume only for eligible dead manual sessions on an online original runner', () => {
    expect(isSessionResumable(session, 'dead', true)).toBe(true);
    expect(isSessionResumable(session, 'idle', true)).toBe(false);
    expect(isSessionResumable({ ...session, runId: 'run-1' }, 'dead', true)).toBe(false);
    expect(isSessionResumable({ ...session, containerId: 'container-1' }, 'dead', true)).toBe(false);
    expect(isSessionResumable({ ...session, nativeSessionId: null }, 'dead', true)).toBe(false);
    expect(isSessionResumable(session, 'dead', false)).toBe(false);

    const visible = renderToStaticMarkup(<ResumeAction visible resuming={false} onResume={vi.fn()} />);
    const hidden = renderToStaticMarkup(<ResumeAction visible={false} resuming={false} onResume={vi.fn()} />);
    expect(visible).toContain('恢复会话');
    expect(hidden).not.toContain('恢复会话');
  });

  it('disables the action while waiting for a runner state update', () => {
    const markup = renderToStaticMarkup(<ResumeAction visible resuming onResume={vi.fn()} />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('恢复中…');
  });
});
