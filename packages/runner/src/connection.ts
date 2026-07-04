/**
 * 与 server 的长连接：WebSocket + JSON-RPC 2.0，断线指数退避重连。
 * 双向：本端可 call() server 方法；server 下发的请求交给 handler 处理。
 */

import WebSocket from 'ws';
import { createId } from '@paralleldrive/cuid2';
import {
  jsonRpcMessageSchema,
  serverMethods,
  type JsonRpcRequest,
  type ServerMethodName,
  type ServerParams,
  type ServerResult,
} from '@co/protocol';

const RPC_TIMEOUT_MS = 30_000;
const BACKOFF_MAX_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectionOptions {
  url: string;
  token: string;
  handler: (method: string, params: unknown) => Promise<unknown>;
  onConnected: () => Promise<void>;
  onDisconnected: () => void;
}

export class ServerConnection {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private backoffMs = 1_000;
  private stopped = false;

  constructor(private readonly opts: ConnectionOptions) {}

  connect(): void {
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1_000;
      this.opts.onConnected().catch((err) => {
        console.error('[runner] onConnected failed:', err);
        ws.close();
      });
    });

    ws.on('message', (data) => {
      void this.onMessage(String(data));
    });

    ws.on('error', (err) => {
      console.error('[runner] ws error:', err.message);
    });

    ws.on('close', () => {
      this.onClose();
    });
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  async call<M extends ServerMethodName>(method: M, params: ServerParams<M>): Promise<ServerResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('server connection not open');
    }
    const id = createId();
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(req));
    });
    return serverMethods[method].result.parse(raw) as ServerResult<M>;
  }

  private async onMessage(text: string): Promise<void> {
    let msg;
    try {
      msg = jsonRpcMessageSchema.parse(JSON.parse(text));
    } catch {
      console.error('[runner] invalid json-rpc message from server');
      return;
    }

    if ('method' in msg) {
      let response;
      try {
        const result = await this.opts.handler(msg.method, msg.params);
        response = { jsonrpc: '2.0' as const, id: msg.id ?? null, result };
      } catch (err) {
        response = {
          jsonrpc: '2.0' as const,
          id: msg.id ?? null,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        };
      }
      if (msg.id !== undefined && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(response));
      }
      return;
    }

    if (msg.id !== null && typeof msg.id === 'string') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private onClose(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
    }
    this.pending.clear();
    this.opts.onDisconnected();
    if (this.stopped) {
      return;
    }
    console.log(`[runner] disconnected, retrying in ${this.backoffMs}ms`);
    setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }
}
