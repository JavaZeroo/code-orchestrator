import { describe, expect, it } from 'vitest';
import { parseAccelIndices } from './config';

describe('parseAccelIndices', () => {
  it('expands ranges and keeps standalone indices', () => {
    expect(parseAccelIndices('0-3, 6, 8-9')).toEqual([0, 1, 2, 3, 6, 8, 9]);
  });

  it('deduplicates overlapping declarations while preserving order', () => {
    expect(parseAccelIndices('2,0-2,2-3')).toEqual([2, 0, 1, 3]);
  });

  it.each(['0-two', '3-1', '-1', '0,,2'])('rejects invalid segment syntax in %j', (value) => {
    expect(() => parseAccelIndices(value)).toThrow(/ACCEL_INDICES/);
  });
});
