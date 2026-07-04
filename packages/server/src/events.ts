/**
 * 进程内事件总线 + append-only 持久化（design §2 的地基）。
 * web 客户端订阅、编排引擎消费、审计追溯都挂在这条总线上。
 */

import { EventEmitter } from 'node:events';
import { getDb, hasDb, schema } from './db/index';

export interface OrchEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  payload: unknown;
}

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/** 广播并落库；DB 未就绪时仅广播（返回 seq=-1） */
export async function publish(evt: OrchEvent): Promise<number> {
  let seq = -1;
  if (hasDb()) {
    const rows = await getDb()
      .insert(schema.events)
      .values({
        sessionId: evt.sessionId,
        runId: evt.runId,
        type: evt.type,
        payload: evt.payload as object,
      })
      .returning({ seq: schema.events.seq });
    seq = rows[0]?.seq ?? -1;
  }
  bus.emit('event', { ...evt, seq });
  return seq;
}
