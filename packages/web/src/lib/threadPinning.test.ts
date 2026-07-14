import { describe, expect, it } from 'vitest';
import { partitionThreadList } from './threadPinning';

interface Thread {
  id: string;
  waiting: boolean;
  pinnedAt: string | null;
  activeAt: string;
}

const order = {
  isWaiting: (thread: Thread) => thread.waiting,
  pinnedAt: (thread: Thread) => thread.pinnedAt,
  activeAt: (thread: Thread) => thread.activeAt,
};

describe('persistent thread pinning order', () => {
  it('places urgent threads before pinned threads and sorts ordinary threads by activity', () => {
    const buckets = partitionThreadList([
      { id: 'ordinary-new', waiting: false, pinnedAt: null, activeAt: '2026-07-14T10:00:00Z' },
      { id: 'pinned-old', waiting: false, pinnedAt: '2026-07-14T08:00:00Z', activeAt: '2026-07-01T00:00:00Z' },
      { id: 'urgent-pinned', waiting: true, pinnedAt: '2026-07-14T11:00:00Z', activeAt: '2026-07-14T11:00:00Z' },
      { id: 'ordinary-old', waiting: false, pinnedAt: null, activeAt: '2026-07-13T10:00:00Z' },
      { id: 'pinned-new', waiting: false, pinnedAt: '2026-07-14T09:00:00Z', activeAt: '2026-06-01T00:00:00Z' },
    ], order);

    expect(buckets.waiting.map((thread) => thread.id)).toEqual(['urgent-pinned']);
    expect(buckets.pinned.map((thread) => thread.id)).toEqual(['pinned-new', 'pinned-old']);
    expect(buckets.rest.map((thread) => thread.id)).toEqual(['ordinary-new', 'ordinary-old']);
  });

  it('returns an unpinned thread to activity ordering', () => {
    const buckets = partitionThreadList([
      { id: 'just-unpinned', waiting: false, pinnedAt: null, activeAt: '2026-07-01T00:00:00Z' },
      { id: 'recent', waiting: false, pinnedAt: null, activeAt: '2026-07-14T00:00:00Z' },
    ], order);

    expect(buckets.pinned).toEqual([]);
    expect(buckets.rest.map((thread) => thread.id)).toEqual(['recent', 'just-unpinned']);
  });
});
