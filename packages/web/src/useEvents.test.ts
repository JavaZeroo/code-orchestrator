import { describe, expect, it } from 'vitest';
import type { EventRow, RunThreadPage, SessionEventPage } from './api';
import {
  reduceRunEventHistory,
  reduceSessionEventHistory,
  type RunEventHistoryState,
  type SessionEventHistoryState,
} from './useEvents';

function event(seq: number): EventRow {
  return { seq, type: 'session.message', payload: { seq } };
}

function page(events: number[], hasEarlier: boolean, before: number | null): SessionEventPage {
  return {
    events: events.map(event),
    page: { hasEarlier, before },
  };
}

const emptyHistory: SessionEventHistoryState = {
  events: [],
  hasEarlier: false,
  before: null,
};

describe('session event history', () => {
  it('prepends backward pages in order, removes overlap, and records exhaustion', () => {
    let history = reduceSessionEventHistory(emptyHistory, {
      kind: 'page',
      page: page([5, 4], true, 4),
    });
    expect(history.events.map((row) => row.seq)).toEqual([4, 5]);
    expect(history).toMatchObject({ hasEarlier: true, before: 4 });

    history = reduceSessionEventHistory(history, {
      kind: 'page',
      page: page([2, 3, 4], true, 2),
    });
    expect(history.events.map((row) => row.seq)).toEqual([2, 3, 4, 5]);
    expect(new Set(history.events.map((row) => row.seq)).size).toBe(history.events.length);

    history = reduceSessionEventHistory(history, {
      kind: 'page',
      page: page([1, 2], false, null),
    });
    expect(history.events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(history).toMatchObject({ hasEarlier: false, before: null });
  });

  it('keeps the backward cursor while merging websocket and polling events', () => {
    let history = reduceSessionEventHistory(emptyHistory, {
      kind: 'page',
      page: page([3, 4], true, 3),
    });

    history = reduceSessionEventHistory(history, {
      kind: 'live',
      events: [event(6), event(4), event(5)],
    });
    expect(history.events.map((row) => row.seq)).toEqual([3, 4, 5, 6]);
    expect(history).toMatchObject({ hasEarlier: true, before: 3 });

    history = reduceSessionEventHistory(history, {
      kind: 'page',
      page: page([1, 2], false, null),
    });
    expect(history.events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(history.hasEarlier).toBe(false);
  });
});

describe('run event history', () => {
  it('prepends earlier pages without disrupting live events or duplicating overlaps', () => {
    const runPage = (
      events: number[],
      hasEarlier: boolean,
      before: number | null,
    ): Pick<RunThreadPage, 'events' | 'page'> => ({
      events: events.map(event),
      page: { hasEarlier, before },
    });
    let history: RunEventHistoryState = { events: [], hasEarlier: false, before: null };

    history = reduceRunEventHistory(history, {
      kind: 'page',
      page: runPage([4, 5], true, 4),
    });
    history = reduceRunEventHistory(history, {
      kind: 'live',
      events: [event(6), event(5)],
    });
    expect(history.events.map((row) => row.seq)).toEqual([4, 5, 6]);
    expect(history).toMatchObject({ hasEarlier: true, before: 4 });

    history = reduceRunEventHistory(history, {
      kind: 'page',
      page: runPage([1, 2, 3, 4], false, null),
    });
    expect(history.events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(history.events.map((row) => row.seq)).size).toBe(history.events.length);
    expect(history).toMatchObject({ hasEarlier: false, before: null });
  });
});
