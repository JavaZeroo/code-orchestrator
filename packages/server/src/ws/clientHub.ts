/**
 * web 前端订阅点：/ws/client（可选 ?sessionId= 过滤）。
 * 把事件总线上的事件（含 DB seq）实时推给浏览器；历史由 REST 拉取，前端按 seq 去重合并。
 * M1 无鉴权（内网 + better-auth 于 M2 接入）。
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { sessionUser } from '../auth';
import { bus } from '../events';

interface ClientConn {
  socket: WebSocket;
  sessionId?: string;
  runId?: string;
}

const clients = new Set<ClientConn>();

export function registerClientHub(app: FastifyInstance, authEnabled = false): void {
  bus.on('event', (evt: { type: string; sessionId?: string; runId?: string; seq?: number; payload: unknown }) => {
    if (clients.size === 0) {
      return;
    }
    const message = JSON.stringify(evt);
    for (const client of clients) {
      if (client.sessionId && evt.sessionId !== client.sessionId) {
        continue;
      }
      if (client.runId && evt.runId !== client.runId) {
        continue;
      }
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(message);
      }
    }
  });

  app.get<{ Querystring: { sessionId?: string; runId?: string } }>(
    '/ws/client',
    { websocket: true },
    (socket, req) => {
      void (async () => {
        if (authEnabled && !(await sessionUser(req as never))) {
          socket.close(4401, 'unauthorized');
          return;
        }
        const conn: ClientConn = { socket, sessionId: req.query.sessionId, runId: req.query.runId };
        clients.add(conn);
        socket.on('close', () => {
          clients.delete(conn);
        });
      })();
    },
  );
}
