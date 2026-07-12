import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  isRunRetryEligible,
  runArchiveMode,
  runProgressionMode,
  RunArchiveAction,
  RunProgressionAction,
  runRetryAction,
  RunRetryAction,
  runRetestAction,
  RunTitleEditor,
  RunTranscriptExportAction,
  type RunRetryActionDependencies,
  type RunRetestActionDependencies,
} from './RunView';
import { RUN_TITLE_MAX_LENGTH } from './lib/runTitle';

function dependencies(overrides: Partial<RunRetestActionDependencies> = {}) {
  return {
    request: vi.fn().mockResolvedValue({ ok: true, confirmation: 'pending' }),
    success: vi.fn(),
    error: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } satisfies RunRetestActionDependencies;
}

function retryDependencies(overrides: Partial<RunRetryActionDependencies> = {}) {
  return {
    request: vi.fn().mockResolvedValue({
      ok: true,
      run: { id: 'run-1', status: 'running', endedAt: null },
      retriedNodeIds: ['deploy'],
    }),
    success: vi.fn(),
    error: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } satisfies RunRetryActionDependencies;
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
    expect(runArchiveMode({ status: 'paused', archivedAt: null })).toBeNull();
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

describe('RunView transcript export action', () => {
  it('is available and disables repeated exports while complete history is loading', () => {
    const ready = renderToStaticMarkup(createElement(RunTranscriptExportAction, {
      exporting: false,
      onExport: vi.fn(),
    }));
    const exporting = renderToStaticMarkup(createElement(RunTranscriptExportAction, {
      exporting: true,
      onExport: vi.fn(),
    }));

    expect(ready).toContain('导出记录');
    expect(ready).not.toContain('disabled=""');
    expect(exporting).toContain('disabled=""');
    expect(exporting).toContain('导出中…');
  });
});

describe('RunView progression action', () => {
  it('offers pause for active runs and resume only for paused runs', () => {
    expect(runProgressionMode({ status: 'running' })).toBe('pause');
    expect(runProgressionMode({ status: 'waiting_human' })).toBe('pause');
    expect(runProgressionMode({ status: 'paused' })).toBe('resume');
    expect(runProgressionMode({ status: 'done' })).toBeNull();
    expect(runProgressionMode({ status: 'failed' })).toBeNull();
    expect(runProgressionMode({ status: 'cancelled' })).toBeNull();

    const pause = renderToStaticMarkup(createElement(RunProgressionAction, {
      mode: 'pause',
      updating: false,
      onChange: vi.fn(),
    }));
    const resume = renderToStaticMarkup(createElement(RunProgressionAction, {
      mode: 'resume',
      updating: false,
      onChange: vi.fn(),
    }));
    const hidden = renderToStaticMarkup(createElement(RunProgressionAction, {
      mode: null,
      updating: false,
      onChange: vi.fn(),
    }));
    expect(pause).toContain('暂停');
    expect(resume).toContain('恢复');
    expect(hidden).toBe('');
  });

  it('disables progression controls while a transition is pending', () => {
    const pausing = renderToStaticMarkup(createElement(RunProgressionAction, {
      mode: 'pause',
      updating: true,
      onChange: vi.fn(),
    }));
    const resuming = renderToStaticMarkup(createElement(RunProgressionAction, {
      mode: 'resume',
      updating: true,
      onChange: vi.fn(),
    }));
    expect(pausing).toContain('disabled=""');
    expect(pausing).toContain('暂停中…');
    expect(resuming).toContain('disabled=""');
    expect(resuming).toContain('恢复中…');
  });
});

describe('RunView retry action', () => {
  it('offers Retry only for an unarchived failed run', () => {
    expect(isRunRetryEligible({ status: 'failed', archivedAt: null })).toBe(true);
    expect(isRunRetryEligible({ status: 'failed', archivedAt: '2026-07-11T05:00:00Z' })).toBe(false);
    expect(isRunRetryEligible({ status: 'running', archivedAt: null })).toBe(false);
    expect(isRunRetryEligible({ status: 'paused', archivedAt: null })).toBe(false);
    expect(isRunRetryEligible({ status: 'done', archivedAt: null })).toBe(false);

    const visible = renderToStaticMarkup(createElement(RunRetryAction, {
      eligible: true,
      retrying: false,
      onRetry: vi.fn(),
    }));
    const hidden = renderToStaticMarkup(createElement(RunRetryAction, {
      eligible: false,
      retrying: false,
      onRetry: vi.fn(),
    }));
    expect(visible).toContain('重试');
    expect(hidden).toBe('');
  });

  it('disables Retry while the request is pending', () => {
    const markup = renderToStaticMarkup(createElement(RunRetryAction, {
      eligible: true,
      retrying: true,
      onRetry: vi.fn(),
    }));
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('重试中…');
  });

  it('reports retry failures without refreshing stale run state', async () => {
    const failure = new Error('409: run is no longer eligible to retry');
    const deps = retryDependencies({ request: vi.fn().mockRejectedValue(failure) });

    await expect(runRetryAction('run-1', deps)).rejects.toBe(failure);
    expect(deps.error).toHaveBeenCalledWith('运行重试失败：409: run is no longer eligible to retry');
    expect(deps.success).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('refreshes the existing run after retry succeeds', async () => {
    const deps = retryDependencies();

    const result = await runRetryAction('run-1', deps);

    expect(deps.request).toHaveBeenCalledWith('run-1');
    expect(deps.success).toHaveBeenCalledWith('运行已重新开始');
    expect(deps.refresh).toHaveBeenCalledWith(result);
    expect(deps.error).not.toHaveBeenCalled();
  });
});

describe('RunView title editor', () => {
  const handlers = {
    onEdit: vi.fn(),
    onDraftChange: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
  };

  it('shows the effective run title with an inline rename action', () => {
    const markup = renderToStaticMarkup(createElement(RunTitleEditor, {
      title: 'Production rollout',
      draft: 'Production rollout',
      editing: false,
      saving: false,
      ...handlers,
    }));

    expect(markup).toContain('Production rollout');
    expect(markup).toContain('aria-label="重命名运行"');
  });

  it('renders a bounded editor and disables it while the title is saving', () => {
    const markup = renderToStaticMarkup(createElement(RunTitleEditor, {
      title: 'Production rollout',
      draft: 'Release 2026.07',
      editing: true,
      saving: true,
      ...handlers,
    }));

    expect(markup).toContain('aria-label="运行标题"');
    expect(markup).toContain(`maxLength="${RUN_TITLE_MAX_LENGTH}"`);
    expect(markup).toContain('disabled=""');
  });
});
