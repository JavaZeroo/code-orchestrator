import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EventRow, type SessionEventPage } from './api';

export interface SessionEventHistoryState {
  events: EventRow[];
  hasEarlier: boolean;
  before: number | null;
}

export type SessionEventHistoryUpdate =
  | { kind: 'page'; page: SessionEventPage }
  | { kind: 'live'; events: EventRow[] };

export function mergeSessionEventRows(current: EventRow[], incoming: EventRow[]): EventRow[] {
  const seen = new Set(current.map((event) => event.seq));
  const fresh: EventRow[] = [];
  for (const event of incoming) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    fresh.push(event);
  }
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((left, right) => left.seq - right.seq);
}

export function reduceSessionEventHistory(
  state: SessionEventHistoryState,
  update: SessionEventHistoryUpdate,
): SessionEventHistoryState {
  if (update.kind === 'live') {
    const events = mergeSessionEventRows(state.events, update.events);
    return events === state.events ? state : { ...state, events };
  }
  return {
    events: mergeSessionEventRows(state.events, update.page.events),
    hasEarlier: update.page.page.hasEarlier,
    before: update.page.page.before,
  };
}

export interface SessionEventHistory extends SessionEventHistoryState {
  loadingEarlier: boolean;
  loadEarlier: () => Promise<SessionEventPage | undefined>;
}

const EMPTY_SESSION_HISTORY: SessionEventHistoryState = {
  events: [],
  hasEarlier: false,
  before: null,
};

/** 先开 WS（实时缓冲）再拉历史，按 seq 去重合并——不丢中间事件；
 *  另每 10s 以 since=maxSeq 增量补拉，并可按 before 游标向前加载历史。 */
export function useSessionEvents(sessionId: string): SessionEventHistory {
  const [history, setHistory] = useState<SessionEventHistoryState>(EMPTY_SESSION_HISTORY);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const maxSeqRef = useRef(0);
  const beforeRef = useRef<number | null>(null);
  const loadingEarlierRef = useRef(false);
  const activeSessionRef = useRef(sessionId);
  activeSessionRef.current = sessionId;

  const applyUpdate = useCallback((update: SessionEventHistoryUpdate) => {
    setHistory((previous) => {
      const next = reduceSessionEventHistory(previous, update);
      maxSeqRef.current = next.events[next.events.length - 1]?.seq ?? 0;
      beforeRef.current = next.before;
      return next;
    });
  }, []);

  useEffect(() => {
    setHistory(EMPTY_SESSION_HISTORY);
    maxSeqRef.current = 0;
    beforeRef.current = null;
    loadingEarlierRef.current = false;
    setLoadingEarlier(false);
    if (!sessionId) return;
    let disposed = false;
    let initialPageApplied = false;
    const applyInitialPage = (page: SessionEventPage) => {
      if (disposed || initialPageApplied) return;
      initialPageApplied = true;
      applyUpdate({ kind: 'page', page });
    };

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?sessionId=${sessionId}`);
    ws.onmessage = (e) => {
      if (disposed) return;
      try {
        applyUpdate({ kind: 'live', events: [JSON.parse(e.data as string) as EventRow] });
      } catch {
        // ignore malformed frames
      }
    };
    api.events(sessionId)
      .then(applyInitialPage)
      .catch(console.error);
    const timer = setInterval(() => {
      const since = maxSeqRef.current;
      api.events(sessionId, since > 0 ? { since } : undefined)
        .then((page) => {
          if (!disposed) {
            if (since > 0) applyUpdate({ kind: 'live', events: page.events });
            else if (!initialPageApplied) applyInitialPage(page);
            else if (page.events.length > 0) applyUpdate({ kind: 'page', page });
          }
        })
        .catch(() => {});
    }, 10_000);

    return () => {
      disposed = true;
      ws.close();
      clearInterval(timer);
    };
  }, [applyUpdate, sessionId]);

  const loadEarlier = useCallback(async () => {
    const before = beforeRef.current;
    if (!sessionId || before == null || loadingEarlierRef.current) return undefined;
    const requestedSession = sessionId;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const page = await api.events(requestedSession, { before });
      if (activeSessionRef.current !== requestedSession) return undefined;
      applyUpdate({ kind: 'page', page });
      return page;
    } finally {
      if (activeSessionRef.current === requestedSession) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [applyUpdate, sessionId]);

  return { ...history, loadingEarlier, loadEarlier };
}

/** run 时间线：先开 WS（?runId=）再拉历史 thread，按 seq 去重合并 */
export function useRunEvents(runId: string): EventRow[] {
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    const add = (rows: EventRow[]) => {
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const fresh = rows.filter((r) => !seen.has(r.seq));
        if (fresh.length === 0) return prev;
        return [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
      });
    };

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?runId=${runId}`);
    ws.onmessage = (e) => {
      try {
        add([JSON.parse(e.data as string) as EventRow]);
      } catch {
        // ignore malformed frames
      }
    };
    api.runThread(runId).then((d) => add(d.events)).catch(console.error);

    return () => ws.close();
  }, [runId]);

  return events;
}
