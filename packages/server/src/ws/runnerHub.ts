/**
 * runner 接入点：/ws/runner，纯 WebSocket + JSON-RPC 2.0（决策 §12.5）。
 * server→runner 调用经 callRunner()；runner→server 上报在 handleServerMethod() 分发。
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { createId } from '@paralleldrive/cuid2';
import {
  jsonRpcMessageSchema,
  runnerMethods,
  serverMethods,
  workflowDefSchema,
  type JsonRpcRequest,
  type MachineInfo,
  type RunnerMethodName,
  type RunnerParams,
  type RunnerResult,
  type ServerMethodName,
} from '@co/protocol';
import { and, eq, lt, ne } from 'drizzle-orm';
import { getDb, hasDb, schema } from '../db/index';
import { env } from '../env';
import { publish } from '../events';

const RPC_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface RunnerConn {
  socket: WebSocket;
  machine: MachineInfo | null;
  pending: Map<string | number, Pending>;
}

const runners = new Map<string, RunnerConn>();

export function listMachines(): MachineInfo[] {
  return [...runners.values()]
    .map((c) => c.machine)
    .filter((m): m is MachineInfo => m !== null);
}

export async function callRunner<M extends RunnerMethodName>(
  machineId: string,
  method: M,
  params: RunnerParams<M>,
  timeoutMs?: number,
): Promise<RunnerResult<M>> {
  const conn = runners.get(machineId);
  if (!conn) {
    throw new Error(`runner offline: ${machineId}`);
  }
  const id = createId();
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
  const raw = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`rpc timeout: ${method} @ ${machineId}`));
    }, timeoutMs ?? RPC_TIMEOUT_MS);
    conn.pending.set(id, { resolve, reject, timer });
    conn.socket.send(JSON.stringify(req));
  });
  return runnerMethods[method].result.parse(raw) as RunnerResult<M>;
}

async function handleServerMethod(conn: RunnerConn, method: string, params: unknown): Promise<unknown> {
  switch (method as ServerMethodName) {
    case 'machine.register': {
      const p = serverMethods['machine.register'].params.parse(params);
      conn.machine = p.info;
      runners.set(p.info.id, conn);
      if (hasDb()) {
        await getDb()
          .insert(schema.machines)
          .values({
            id: p.info.id,
            name: p.info.name,
            labels: p.info.labels,
            info: p.info as unknown as Record<string, unknown>,
            dataRoot: p.info.dataRoot ?? null,
            resources: p.info.resources ?? [],
            status: 'online',
            lastActiveAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.machines.id,
            set: {
              name: p.info.name,
              labels: p.info.labels,
              info: p.info as unknown as Record<string, unknown>,
              dataRoot: p.info.dataRoot ?? null,
              resources: p.info.resources ?? [],
              status: 'online',
              lastActiveAt: new Date(),
            },
          });
      }
      await publish({ type: 'machine.online', payload: p.info });
      return { ok: true, serverTime: Date.now() };
    }
    case 'machine.heartbeat': {
      const p = serverMethods['machine.heartbeat'].params.parse(params);
      // 会话对账：runner 内存是唯一事实来源——DB 里该机器的"活"会话若不在心跳清单中即已消亡
      // （覆盖 runner 重启丢会话的场景；server 重启不误伤，因为心跳如实上报存活会话）
      if (hasDb()) {
        // 机器存活刷新（design-v2 M1）：修此前"machines 只在 register 写一次、lastActiveAt 永不更新"的陈旧问题
        await getDb()
          .update(schema.machines)
          .set({ status: 'online', lastActiveAt: new Date() })
          .where(eq(schema.machines.id, p.machineId));
        const alive = new Set(p.sessions.map((s) => s.sessionId));
        const dbActive = await getDb()
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.machineId, p.machineId),
              ne(schema.sessions.state, 'dead'),
              // 刚 spawn 的会话可能尚未进入 runner 注册表，留 60s 窗口避免误杀
              lt(schema.sessions.createdAt, new Date(Date.now() - 60_000)),
            ),
          );
        for (const row of dbActive) {
          if (!alive.has(row.id)) {
            await getDb().update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, row.id));
            await publish({ type: 'session.state', sessionId: row.id, payload: { state: 'dead', reason: 'not reported by runner' } });
          }
        }
      }
      return { ok: true };
    }
    case 'session.event': {
      const p = serverMethods['session.event'].params.parse(params);
      const seq = await publish({ type: 'session.message', sessionId: p.sessionId, payload: p.envelope });
      return { seq };
    }
    case 'session.state': {
      const p = serverMethods['session.state'].params.parse(params);
      if (hasDb()) {
        await getDb()
          .update(schema.sessions)
          .set({
            state: p.state,
            ...(p.nativeSessionId ? { nativeSessionId: p.nativeSessionId } : {}),
            ...(p.usage ? { usage: p.usage } : {}),
          })
          .where(eq(schema.sessions.id, p.sessionId));
      }
      await publish({
        type: 'session.state',
        sessionId: p.sessionId,
        payload: { state: p.state, nativeSessionId: p.nativeSessionId, usage: p.usage },
      });
      return { ok: true };
    }
    case 'approval.request': {
      const p = serverMethods['approval.request'].params.parse(params);
      if (hasDb()) {
        await getDb().insert(schema.approvals).values({
          id: p.request.id,
          kind: p.request.kind,
          sessionId: p.request.sessionId,
          runId: p.request.runId,
          nodeId: p.request.nodeId,
          title: p.request.title,
          payload: p.request.payload,
          risk: p.request.risk,
          status: 'pending',
        });
      }
      // TODO(M2): 通知出口（钉钉/企微 webhook）
      await publish({ type: 'approval.requested', sessionId: p.request.sessionId, payload: p.request });
      return { ok: true };
    }
    case 'workflow.draft': {
      const p = serverMethods['workflow.draft'].params.parse(params);
      const parsed = workflowDefSchema.safeParse(p.graph);
      if (!parsed.success) {
        return { ok: false, error: `schema 校验失败: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ')}` };
      }
      await publish({ type: 'workflow.draft', sessionId: p.sessionId, payload: parsed.data });
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

export async function registerRunnerHub(app: FastifyInstance): Promise<void> {
  app.get('/ws/runner', { websocket: true }, (socket, req) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${env.RUNNER_SHARED_TOKEN}`) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const conn: RunnerConn = { socket, machine: null, pending: new Map() };

    socket.on('message', (data: Buffer) => {
      void (async () => {
        let msg;
        try {
          msg = jsonRpcMessageSchema.parse(JSON.parse(data.toString()));
        } catch {
          app.log.warn('runner sent invalid json-rpc message');
          return;
        }

        if ('method' in msg) {
          let response;
          try {
            const result = await handleServerMethod(conn, msg.method, msg.params);
            response = { jsonrpc: '2.0' as const, id: msg.id ?? null, result };
          } catch (err) {
            response = {
              jsonrpc: '2.0' as const,
              id: msg.id ?? null,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            };
          }
          if (msg.id !== undefined) {
            socket.send(JSON.stringify(response));
          }
          return;
        }

        const pending = msg.id === null ? undefined : conn.pending.get(msg.id);
        if (pending && msg.id !== null) {
          conn.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      })();
    });

    socket.on('close', () => {
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('runner disconnected'));
      }
      conn.pending.clear();
      if (conn.machine) {
        const machineId = conn.machine.id;
        runners.delete(machineId);
        if (hasDb()) {
          void getDb().update(schema.machines).set({ status: 'offline' }).where(eq(schema.machines.id, machineId));
        }
        void publish({ type: 'machine.offline', payload: { id: machineId } });
      }
    });
  });
}
