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
  /** 非共享 token 连入时暂存，register 时与机器行 enroll_token+id 精确核对 */
  enrollToken?: string;
}

const runners = new Map<string, RunnerConn>();

/** 会话→runId 懒缓存：runId 创建后不变，查一次即缓存（含 null，交互会话 O(1) 跳过） */
const sessionRunIdCache = new Map<string, string | null>();
async function getSessionRunId(sessionId: string): Promise<string | null | undefined> {
  if (sessionRunIdCache.has(sessionId)) return sessionRunIdCache.get(sessionId);
  if (!hasDb()) return undefined;
  const rows = await getDb()
    .select({ runId: schema.sessions.runId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  const runId = rows[0]?.runId ?? null;
  sessionRunIdCache.set(sessionId, runId);
  return runId;
}

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
      // 每机凭证：token 必须命中该 id 的机器行（UI「添加机器」生成），否则拒绝
      if (conn.enrollToken !== undefined) {
        const rows = hasDb()
          ? await getDb().select({ id: schema.machines.id, enrollToken: schema.machines.enrollToken }).from(schema.machines).where(eq(schema.machines.id, p.info.id)).limit(1)
          : [];
        if (!rows[0]?.enrollToken || rows[0].enrollToken !== conn.enrollToken) {
          conn.socket.close(4403, 'enroll token mismatch');
          throw new Error(`enroll token mismatch for machine ${p.info.id}`);
        }
      }
      // schedulingPaused 是 server 管理态，绝不接受 runner 自报值。
      conn.machine = { ...p.info, schedulingPaused: false };
      if (hasDb()) {
        // 行已存在时 name/labels/调度态以 DB 为准，回填内存供调度读取。
        const existing = await getDb().select({
          name: schema.machines.name,
          labels: schema.machines.labels,
          schedulingPaused: schema.machines.schedulingPaused,
        }).from(schema.machines).where(eq(schema.machines.id, p.info.id)).limit(1);
        if (existing[0]) {
          conn.machine = {
            ...p.info,
            name: existing[0].name,
            labels: existing[0].labels,
            schedulingPaused: existing[0].schedulingPaused,
          };
        }
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
            // name/labels 不覆盖：行已存在时以 UI/DB 为准（添加机器 UI 可编辑），runner env 只在首次注册时生效
            set: {
              info: p.info as unknown as Record<string, unknown>,
              dataRoot: p.info.dataRoot ?? null,
              resources: p.info.resources ?? [],
              status: 'online',
              lastActiveAt: new Date(),
            },
          });
      }
      // DB 调度态回填完成后才暴露给放置路径，避免重连瞬间把暂停机当成可用。
      runners.set(p.info.id, conn);
      await publish({ type: 'machine.online', payload: conn.machine });
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
          .set({
            status: 'online',
            lastActiveAt: new Date(),
            // 组件缓存自报（有携带才覆盖；15s 一拍的小 jsonb 写入可接受）
            ...(p.componentCache ? { componentCache: p.componentCache } : {}),
          })
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
      const runId = await getSessionRunId(p.sessionId);
      const seq = await publish({ type: 'session.message', sessionId: p.sessionId, runId: runId ?? undefined, payload: p.envelope });
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
      const runId = await getSessionRunId(p.sessionId);
      await publish({
        type: 'session.state',
        sessionId: p.sessionId,
        runId: runId ?? undefined,
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
    case 'task.plan': {
      const p = serverMethods['task.plan'].params.parse(params);
      await publish({ type: 'task.plan', sessionId: p.sessionId, payload: p.plan });
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

export async function registerRunnerHub(app: FastifyInstance): Promise<void> {
  app.get('/ws/runner', { websocket: true }, (socket, req) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || auth === 'Bearer ') {
      socket.close(4401, 'unauthorized');
      return;
    }

    const conn: RunnerConn = { socket, machine: null, pending: new Map() };
    if (auth !== `Bearer ${env.RUNNER_SHARED_TOKEN}`) {
      conn.enrollToken = auth!.slice('Bearer '.length);
    }

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
