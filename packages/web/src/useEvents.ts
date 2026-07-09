import { useEffect, useState } from 'react';
import { api, type EventRow } from './api';

/** 先开 WS（实时缓冲）再拉历史，按 seq 去重合并——不丢中间事件；
 *  另每 10s 以 since=maxSeq 增量补拉，兜底 WS 掉线/后台标签页漏帧 */
export function useSessionEvents(sessionId: string): EventRow[] {
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    let maxSeq = 0;
    const add = (rows: EventRow[]) => {
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const fresh = rows.filter((r) => !seen.has(r.seq));
        if (fresh.length === 0) {
          return prev;
        }
        const next = [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
        maxSeq = next[next.length - 1]!.seq;
        return next;
      });
    };

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?sessionId=${sessionId}`);
    ws.onmessage = (e) => {
      try {
        add([JSON.parse(e.data as string) as EventRow]);
      } catch {
        // ignore malformed frames
      }
    };
    api.events(sessionId).then(add).catch(console.error);
    const timer = setInterval(() => {
      api.events(sessionId, maxSeq).then(add).catch(() => {});
    }, 10_000);

    return () => {
      ws.close();
      clearInterval(timer);
    };
  }, [sessionId]);

  return events;
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
