import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeRefRow } from './api';
import { ForgeCard, isForgeRetestEligible, RunHistoryAction } from './RunTimeline';

const gitcodePr: ForgeRefRow = {
  id: 'ref/1',
  forge: 'gitcode',
  kind: 'pr',
  repo: 'mindspore/mindformers',
  number: 8377,
  runId: 'run-1',
  nodeId: null,
  sessionId: null,
  ciStatus: 'failed',
  snapshot: null,
  active: 'yes',
};

describe('ForgeCard retest action', () => {
  it('offers retest only for persisted, active GitCode PR refs', () => {
    expect(isForgeRetestEligible(gitcodePr)).toBe(true);
    expect(isForgeRetestEligible({ ...gitcodePr, id: '' })).toBe(false);
    expect(isForgeRetestEligible({ ...gitcodePr, active: 'no' })).toBe(false);
    expect(isForgeRetestEligible({ ...gitcodePr, kind: 'issue' })).toBe(false);
    expect(isForgeRetestEligible({ ...gitcodePr, forge: 'github' })).toBe(false);

    const eligible = renderToStaticMarkup(<ForgeCard forgeRef={gitcodePr} onRetest={vi.fn()} />);
    const ineligible = renderToStaticMarkup(<ForgeCard forgeRef={{ ...gitcodePr, active: 'no' }} onRetest={vi.fn()} />);
    expect(eligible).toContain('重跑 CI');
    expect(ineligible).not.toContain('重跑 CI');
  });

  it('disables and labels the action while posting or awaiting poller confirmation', () => {
    const posting = renderToStaticMarkup(<ForgeCard forgeRef={gitcodePr} retestState="posting" onRetest={vi.fn()} />);
    const pending = renderToStaticMarkup(<ForgeCard forgeRef={gitcodePr} retestState="pending" onRetest={vi.fn()} />);

    expect(posting).toContain('disabled=""');
    expect(posting).toContain('发送中…');
    expect(pending).toContain('disabled=""');
    expect(pending).toContain('等待 CI 确认');
  });
});

describe('RunHistoryAction', () => {
  it('shows an enabled history control until earlier run events are exhausted', () => {
    const visible = renderToStaticMarkup(<RunHistoryAction visible loading={false} onLoad={vi.fn()} />);
    const loading = renderToStaticMarkup(<RunHistoryAction visible loading onLoad={vi.fn()} />);
    const exhausted = renderToStaticMarkup(<RunHistoryAction visible={false} loading={false} onLoad={vi.fn()} />);

    expect(visible).toContain('加载更早记录');
    expect(visible).not.toContain('disabled=""');
    expect(loading).toContain('disabled=""');
    expect(loading).toContain('加载中…');
    expect(exhausted).toBe('');
  });
});
