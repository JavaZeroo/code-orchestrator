import { afterEach, describe, expect, it, vi } from 'vitest';
import { cn, fmtCost, fmtTokens, relTime, shortModel } from './utils';

describe('web utils', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges conditional class names and resolves Tailwind conflicts', () => {
    expect(cn('px-2', false && 'hidden', ['text-sm', 'px-4'])).toBe('text-sm px-4');
  });

  it('formats cost, token counts, and provider-qualified model names for compact UI labels', () => {
    expect(fmtCost(0.1234)).toBe('$0.123');
    expect(fmtCost(1)).toBe('$1.00');
    expect(fmtTokens(42)).toBe('42');
    expect(fmtTokens(1_500)).toBe('1.5k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
    expect(shortModel(null)).toEqual({ display: 'claude', full: 'claude' });
    expect(shortModel('anthropic/claude-sonnet')).toEqual({
      display: 'claude-sonnet',
      full: 'anthropic/claude-sonnet',
    });
  });

  it('formats relative times around the current clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:00:00Z'));

    expect(relTime('2026-07-09T09:59:40Z')).toBe('刚刚');
    expect(relTime('2026-07-09T09:30:00Z')).toBe('30 分钟前');
    expect(relTime('2026-07-09T07:00:00Z')).toBe('3 小时前');
    expect(relTime('2026-07-07T10:00:00Z')).toMatch(/7.*7/);
  });
});
