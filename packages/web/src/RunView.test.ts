import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  runArchiveMode,
  RunArchiveAction,
  runRetestAction,
  type RunRetestActionDependencies,
} from './RunView';

function dependencies(overrides: Partial<RunRetestActionDependencies> = {}) {
  return {
    request: vi.fn().mockResolvedValue({ ok: true, confirmation: 'pending' }),
    success: vi.fn(),
    error: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } satisfies RunRetestActionDependencies;
}

describe('runRetestAction', () => {
  it('reports pending confirmation and refreshes the run thread', async () => {
    const deps = dependencies();

    await runRetestAction('ref/1', deps);

    expect(deps.request).toHaveBeenCalledWith('ref/1');
    expect(deps.success).toHaveBeenCalledWith('已发送 /retest，等待 CI 状态确认');
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.error).not.toHaveBeenCalled();
  });

  it('reports request errors, leaves refresh untouched, and rethrows for the card state', async () => {
    const failure = new Error('403: missing GitCode token');
    const deps = dependencies({ request: vi.fn().mockRejectedValue(failure) });

    await expect(runRetestAction('ref/1', deps)).rejects.toBe(failure);
    expect(deps.error).toHaveBeenCalledWith('CI 重跑失败：403: missing GitCode token');
    expect(deps.success).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});

describe('RunView archive action', () => {
  it.each(['done', 'failed', 'cancelled'])('offers archive for an unarchived %s run', (status) => {
    expect(runArchiveMode({ status, archivedAt: null })).toBe('archive');
  });

  it('hides archive for active runs and offers restore for archived runs', () => {
    expect(runArchiveMode({ status: 'running', archivedAt: null })).toBeNull();
    expect(runArchiveMode({ status: 'waiting_human', archivedAt: null })).toBeNull();
    expect(runArchiveMode({ status: 'done', archivedAt: '2026-07-11T05:00:00Z' })).toBe('restore');

    const archive = renderToStaticMarkup(createElement(RunArchiveAction, { mode: 'archive', updating: false, onChange: vi.fn() }));
    const restore = renderToStaticMarkup(createElement(RunArchiveAction, { mode: 'restore', updating: false, onChange: vi.fn() }));
    const hidden = renderToStaticMarkup(createElement(RunArchiveAction, { mode: null, updating: false, onChange: vi.fn() }));
    expect(archive).toContain('归档');
    expect(restore).toContain('移出归档');
    expect(hidden).toBe('');
  });

  it('disables archive state changes while the request is pending', () => {
    const markup = renderToStaticMarkup(createElement(RunArchiveAction, { mode: 'archive', updating: true, onChange: vi.fn() }));
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('归档中…');
  });
});
