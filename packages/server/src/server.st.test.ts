import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import WebSocket from 'ws';
import { createApp } from './app';
import { closeDb, getDb, schema } from './db/index';
import { eq } from 'drizzle-orm';
import { markTaskDone, reconcileQueueOnce, type QueuedTask } from './services/taskQueue';

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
  await sql`TRUNCATE TABLE events, approvals, sessions, machines, llm_providers, task_queue, projects RESTART IDENTITY CASCADE`;
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

  it('persists scheduling pause, blocks new placement, and leaves existing sessions running', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-pause' }),
      'session.send': () => ({ ok: true }),
    });
    runners.push(runner);

    await expect(
      runner.callServer('machine.register', {
        info: {
          id: 'm-pause',
          name: 'Maintenance Runner',
          labels: ['dev'],
          resources: [{ kind: 'ascend-npu', index: 0 }],
          runnerVersion: 'st',
          startedAt: Date.now(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    const existing = await app!.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { machineId: 'm-pause', cwd: '/tmp/existing', prompt: 'keep running', agent: 'claude' },
    });
    expect(existing.statusCode).toBe(200);
    const { sessionId } = existing.json() as { sessionId: string };

    const pause = await app!.inject({
      method: 'PATCH',
      url: '/api/machines/m-pause',
      payload: { schedulingPaused: true },
    });
    expect(pause.statusCode).toBe(200);

    const persisted = await app!.inject({ method: 'GET', url: '/api/machines/all' });
    expect(persisted.json()).toMatchObject({
      machines: [{ id: 'm-pause', status: 'online', schedulingPaused: true }],
    });
    const live = await app!.inject({ method: 'GET', url: '/api/machines' });
    expect(live.json()).toMatchObject({
      machines: [{ id: 'm-pause', schedulingPaused: true }],
    });

    const continued = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/send`,
      payload: { text: 'continue existing work' },
    });
    expect(continued.statusCode).toBe(200);
    expect(runner.calls.find((call) => call.method === 'session.send')).toMatchObject({
      params: { sessionId, text: 'continue existing work' },
    });

    const blocked = await app!.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { machineId: 'm-pause', cwd: '/tmp/new', prompt: 'new work', agent: 'claude' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: expect.stringContaining('已暂停新任务调度') });

    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Paused Capacity ST',
        forge: 'github',
        repo: 'example/paused-capacity',
        baseImage: 'example/train:latest',
        accel: { kind: 'ascend-npu' },
      },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };
    const queued = await app!.inject({
      method: 'POST',
      url: '/api/container-sessions',
      payload: { projectId, machineId: 'm-pause', prompt: 'wait until maintenance ends' },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, taskId: expect.any(String) });

    const resume = await app!.inject({
      method: 'PATCH',
      url: '/api/machines/m-pause',
      payload: { schedulingPaused: false },
    });
    expect(resume.statusCode).toBe(200);

    const resumed = await app!.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { machineId: 'm-pause', cwd: '/tmp/resumed', prompt: 'new work after maintenance', agent: 'claude' },
    });
    expect(resumed.statusCode).toBe(200);
    expect(runner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(2);
  });

  it('cancels a queued container session before the background reconciler can dispatch it', async () => {
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Queued ST',
        forge: 'github',
        repo: 'example/queued-st',
        baseImage: 'example/train:latest',
        accel: { kind: 'ascend-npu' },
      },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };

    const spawn = await app!.inject({
      method: 'POST',
      url: '/api/container-sessions',
      payload: { projectId, prompt: 'wait for an NPU', agent: 'claude' },
    });
    expect(spawn.statusCode).toBe(202);
    const { taskId } = spawn.json() as { queued: true; taskId: string };

    const listed = await app!.inject({ method: 'GET', url: `/api/projects/${projectId}/queued-sessions` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      tasks: [{ id: taskId, projectId, prompt: 'wait for an NPU', agent: 'claude' }],
    });

    const before = await app!.inject({ method: 'GET', url: '/api/resources' });
    expect(before.json()).toMatchObject({ queued: 1 });

    const cancelled = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/queued-sessions/${taskId}`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true });

    const rows = await getDb()
      .select({ status: schema.taskQueue.status })
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.id, taskId));
    expect(rows).toEqual([{ status: 'cancelled' }]);

    const after = await app!.inject({ method: 'GET', url: '/api/resources' });
    expect(after.json()).toMatchObject({ queued: 0 });

    const repeatedCancel = await app!.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/queued-sessions/${taskId}`,
    });
    expect(repeatedCancel.statusCode).toBe(409);
    expect(repeatedCancel.json()).toMatchObject({ status: 'cancelled' });

    let dispatchCount = 0;
    await reconcileQueueOnce(async () => {
      dispatchCount += 1;
      return 'started';
    });
    expect(dispatchCount).toBe(0);
  });

  it('reprioritizes pending sessions and dispatches by priority with FIFO ties', async () => {
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Priority Queue ST',
        forge: 'github',
        repo: 'example/priority-queue-st',
        baseImage: 'example/train:latest',
        accel: { kind: 'ascend-npu' },
      },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };

    const enqueue = async (prompt: string) => {
      const response = await app!.inject({
        method: 'POST',
        url: '/api/container-sessions',
        payload: { projectId, prompt, agent: 'claude' },
      });
      expect(response.statusCode).toBe(202);
      return (response.json() as { queued: true; taskId: string }).taskId;
    };

    const oldestId = await enqueue('oldest normal task');
    const firstUrgentId = await enqueue('first urgent task');
    const secondUrgentId = await enqueue('second urgent task');
    const enqueuedBase = Date.now() - 10_000;
    await Promise.all([
      getDb().update(schema.taskQueue).set({ enqueuedAt: new Date(enqueuedBase) }).where(eq(schema.taskQueue.id, oldestId)),
      getDb().update(schema.taskQueue).set({ enqueuedAt: new Date(enqueuedBase + 1_000) }).where(eq(schema.taskQueue.id, firstUrgentId)),
      getDb().update(schema.taskQueue).set({ enqueuedAt: new Date(enqueuedBase + 2_000) }).where(eq(schema.taskQueue.id, secondUrgentId)),
    ]);

    const missing = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/queued-sessions/missing-task`,
      payload: { priority: 10 },
    });
    expect(missing.statusCode).toBe(404);

    for (const taskId of [firstUrgentId, secondUrgentId]) {
      const reprioritized = await app!.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/queued-sessions/${taskId}`,
        payload: { priority: 10 },
      });
      expect(reprioritized.statusCode).toBe(200);
      expect(reprioritized.json()).toEqual({ ok: true, priority: 10 });
    }

    const listed = await app!.inject({ method: 'GET', url: `/api/projects/${projectId}/queued-sessions` });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { tasks: Array<{ id: string; priority: number }> }).tasks).toMatchObject([
      { id: firstUrgentId, priority: 10 },
      { id: secondUrgentId, priority: 10 },
      { id: oldestId, priority: 0 },
    ]);

    const dispatchOrder: string[] = [];
    let claimedUpdateStatus: number | undefined;
    let claimedUpdateBody: unknown;
    await reconcileQueueOnce(async (task) => {
      dispatchOrder.push(task.id);
      if (task.id === firstUrgentId) {
        const claimedUpdate = await app!.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}/queued-sessions/${task.id}`,
          payload: { priority: 20 },
        });
        claimedUpdateStatus = claimedUpdate.statusCode;
        claimedUpdateBody = claimedUpdate.json();
      }
      return 'started';
    });

    expect(dispatchOrder).toEqual([firstUrgentId, secondUrgentId, oldestId]);
    expect(claimedUpdateStatus).toBe(409);
    expect(claimedUpdateBody).toMatchObject({ status: 'scheduled' });

    await markTaskDone(firstUrgentId);
    const terminalUpdate = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/queued-sessions/${firstUrgentId}`,
      payload: { priority: 20 },
    });
    expect(terminalUpdate.statusCode).toBe(409);
    expect(terminalUpdate.json()).toMatchObject({ status: 'done' });
  });

  it('retries a failed queued session through REST and dispatches its original payload', async () => {
    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Retry Queue ST',
        forge: 'github',
        repo: 'example/retry-queue-st',
        baseImage: 'example/train:latest',
        accel: { kind: 'ascend-npu' },
      },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };

    const spawn = await app!.inject({
      method: 'POST',
      url: '/api/container-sessions',
      payload: { projectId, prompt: 'retry this training run', agent: 'claude', model: 'test-model' },
    });
    expect(spawn.statusCode).toBe(202);
    const { taskId } = spawn.json() as { queued: true; taskId: string };

    const reprioritized = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/queued-sessions/${taskId}`,
      payload: { priority: 17 },
    });
    expect(reprioritized.statusCode).toBe(200);

    const originalRows = await getDb()
      .select({ payload: schema.taskQueue.payload, priority: schema.taskQueue.priority })
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.id, taskId));
    expect(originalRows).toHaveLength(1);
    const original = originalRows[0]!;
    const failedEnqueuedAt = new Date('2026-07-10T00:00:00Z');
    await getDb()
      .update(schema.taskQueue)
      .set({ status: 'failed', enqueuedAt: failedEnqueuedAt })
      .where(eq(schema.taskQueue.id, taskId));

    const listed = await app!.inject({ method: 'GET', url: `/api/projects/${projectId}/queued-sessions` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      tasks: [{ id: taskId, status: 'failed', priority: 17, prompt: 'retry this training run' }],
    });

    const missing = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/queued-sessions/missing-task/retry`,
    });
    expect(missing.statusCode).toBe(404);

    const retryStartedAt = Date.now();
    const retried = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/queued-sessions/${taskId}/retry`,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true });

    const retriedRows = await getDb()
      .select({
        status: schema.taskQueue.status,
        payload: schema.taskQueue.payload,
        priority: schema.taskQueue.priority,
        enqueuedAt: schema.taskQueue.enqueuedAt,
      })
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.id, taskId));
    expect(retriedRows).toHaveLength(1);
    expect(retriedRows[0]).toMatchObject({ status: 'pending', payload: original.payload, priority: original.priority });
    expect(retriedRows[0]!.enqueuedAt.getTime()).toBeGreaterThanOrEqual(retryStartedAt - 1_000);

    const repeated = await app!.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/queued-sessions/${taskId}/retry`,
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ status: 'pending' });

    let dispatchedTask: QueuedTask | undefined;
    await reconcileQueueOnce(async (task) => {
      dispatchedTask = task;
      return 'started';
    });

    expect(dispatchedTask).toMatchObject({
      id: taskId,
      payload: original.payload,
      priority: original.priority,
    });
    const finalRows = await getDb()
      .select({ status: schema.taskQueue.status })
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.id, taskId));
    expect(finalRows).toEqual([{ status: 'running' }]);
  });
});
