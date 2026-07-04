import { useEffect, useState } from 'react';
import { api, type EventRow } from './api';

/** 先开 WS（实时缓冲）再拉历史，按 seq 去重合并——不丢中间事件 */
export function useSessionEvents(sessionId: string): EventRow[] {
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    setEvents([]);
    const add = (rows: EventRow[]) => {
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const fresh = rows.filter((r) => !seen.has(r.seq));
        if (fresh.length === 0) {
          return prev;
        }
        return [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
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

    return () => ws.close();
  }, [sessionId]);

  return events;
}
