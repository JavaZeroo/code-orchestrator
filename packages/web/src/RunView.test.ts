import { describe, expect, it, vi } from 'vitest';
import { runRetestAction, type RunRetestActionDependencies } from './RunView';

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
