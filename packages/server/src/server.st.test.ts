import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import WebSocket from 'ws';
import { createApp } from './app';
import { closeDb } from './db/index';

const runSt = Boolean(process.env.DATABASE_URL);
const describeSt = runSt ? describe : describe.skip;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class FakeRunner {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  readonly calls: Array<{ method: string; params: unknown }> = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly handlers: Record<string, (params: unknown) => Promise<unknown> | unknown> = {},
  ) {
    ws.on('message', (data) => {
      void this.onMessage(data.toString());
    });
  }

  static async connect(baseUrl: string, handlers?: Record<string, (params: unknown) => Promise<unknown> | unknown>) {
    const token = process.env.RUNNER_SHARED_TOKEN ?? 'dev-runner-token';
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/runner`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new FakeRunner(ws, handlers);
  }

  callServer(method: string, params: unknown): Promise<unknown> {
    const id = String(this.nextId++);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }

  private async onMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as { id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    if (msg.method) {
      this.calls.push({ method: msg.method, params: msg.params });
      try {
        const result = this.handlers[msg.method]
          ? await this.handlers[msg.method]!(msg.params)
          : { ok: true };
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }));
      } catch (err) {
        this.ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
      return;
    }

    const id = msg.id == null ? undefined : String(msg.id);
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending || !id) {
      return;
    }
    this.pending.delete(id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }
}

let app: FastifyInstance | null = null;
let baseUrl = '';
const runners: FakeRunner[] = [];

async function truncateDb() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`TRUNCATE TABLE events, approvals, sessions, machines, llm_providers RESTART IDENTITY CASCADE`;
  await sql.end({ timeout: 1 });
}

async function startApp() {
  app = await createApp({ authEnabled: false, logger: false, serveWeb: false, startBackground: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind test server');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

describeSt('server ST: API + runner websocket', () => {
  beforeEach(async () => {
    await truncateDb();
    await startApp();
  });

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.close()));
    await app?.close();
    app = null;
    await closeDb();
  });

  it('registers a runner, spawns a session, records events, and decides tool approvals', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-1' }),
      'approval.decide': () => ({ ok: true }),
    });
    runners.push(runner);

    await expect(
      runner.callServer('machine.register', {
        info: {
          id: 'm-st',
          name: 'ST Runner',
          labels: ['dev'],
          resources: [],
          runnerVersion: 'st',
          startedAt: Date.now(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    const machines = await app!.inject({ method: 'GET', url: '/api/machines' });
    expect(machines.statusCode).toBe(200);
    expect(machines.json()).toMatchObject({ machines: [{ id: 'm-st', name: 'ST Runner', labels: ['dev'] }] });

    const spawn = await app!.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { machineId: 'm-st', cwd: '/tmp/work', prompt: 'hello', agent: 'claude' },
    });
    expect(spawn.statusCode).toBe(200);
    const { sessionId } = spawn.json() as { sessionId: string };
    expect(sessionId).toBeTruthy();
    expect(runner.calls.find((call) => call.method === 'session.spawn')).toMatchObject({
      params: { sessionId, cwd: '/tmp/work', prompt: 'hello' },
    });

    await expect(
      runner.callServer('session.state', {
        sessionId,
        state: 'idle',
        nativeSessionId: 'native-1',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, costUsd: 0.01, turns: 1 },
      }),
    ).resolves.toEqual({ ok: true });

    const sessions = await app!.inject({ method: 'GET', url: '/api/sessions' });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({
      sessions: [{ id: sessionId, machineId: 'm-st', state: 'idle', nativeSessionId: 'native-1' }],
    });

    await expect(
      runner.callServer('approval.request', {
        request: {
          id: 'approval-1',
          kind: 'tool',
          sessionId,
          title: 'Run command',
          payload: { toolName: 'Bash', input: { cmd: 'pnpm test' } },
          risk: 'medium',
          requestedAt: Date.now(),
        },
      }),
    ).resolves.toEqual({ ok: true });

    const approvals = await app!.inject({ method: 'GET', url: '/api/approvals' });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json()).toMatchObject({ approvals: [{ id: 'approval-1', status: 'pending' }] });

    const decision = await app!.inject({
      method: 'POST',
      url: '/api/approvals/approval-1/decide',
      payload: { decision: { behavior: 'allow' }, decidedBy: 'st' },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toEqual({ ok: true, status: 'approved' });
    expect(runner.calls.find((call) => call.method === 'approval.decide')).toMatchObject({
      params: { approvalId: 'approval-1', sessionId, decision: { behavior: 'allow' } },
    });

    const events = await app!.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    expect(events.statusCode).toBe(200);
    expect((events.json() as { events: Array<{ type: string }> }).events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['session.created', 'session.state', 'approval.requested', 'approval.decided']),
    );
  });
});
