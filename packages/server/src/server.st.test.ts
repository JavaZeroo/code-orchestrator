import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import WebSocket from 'ws';
import { createApp } from './app';
import { closeDb, getDb, schema } from './db/index';
import { and, eq } from 'drizzle-orm';
import { resumeActiveRuns, scheduleTick, serializeRunProgression, startEngine } from './engine/engine';
import { bus } from './events';
import { encryptSecret } from './services/crypto';
import { markTaskDone, reconcileQueueOnce, type QueuedTask } from './services/taskQueue';
import { getForge } from './forge/registry';
import { deleteHostWorkspaceFile } from '../../runner/src/workspaceDelete';
import { chmodHostWorkspaceFile } from '../../runner/src/workspaceChmod';
import { listHostWorkspaceDirectory } from '../../runner/src/workspaceList';
import { createRunnerMethodHandler } from '../../runner/src/methods';

const run = promisify(execFile);

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

interface ClientEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  seq?: number;
  payload: unknown;
}

async function connectClientEvents(baseUrl: string, sessionId: string, cookie?: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/client?sessionId=${sessionId}`, {
    headers: cookie ? { cookie } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const ready = waitForClientEvent(ws, (event) => event.type === 'st.client.ready');
  const emitReady = () => bus.emit('event', { type: 'st.client.ready', sessionId, payload: {} });
  const timer = setInterval(emitReady, 10);
  emitReady();
  try {
    await ready;
  } finally {
    clearInterval(timer);
  }
  return ws;
}

async function connectRunEvents(baseUrl: string, runId: string, cookie?: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/client?runId=${encodeURIComponent(runId)}`, {
    headers: cookie ? { cookie } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const ready = waitForClientEvent(ws, (event) => event.type === 'st.client.ready');
  const emitReady = () => bus.emit('event', { type: 'st.client.ready', runId, payload: {} });
  const timer = setInterval(emitReady, 10);
  emitReady();
  try {
    await ready;
  } finally {
    clearInterval(timer);
  }
  return ws;
}

function waitForClientEvent(ws: WebSocket, predicate: (event: ClientEvent) => boolean): Promise<ClientEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for client event'));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as ClientEvent;
      if (predicate(event)) {
        cleanup();
        resolve(event);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client websocket closed while waiting for event'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

let app: FastifyInstance | null = null;
let baseUrl = '';
const runners: FakeRunner[] = [];

async function truncateDb() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`TRUNCATE TABLE events, approvals, sessions, resource_reservations, project_materializations, machines, llm_providers, task_queue, projects, workflow_defs, forge_refs, forge_tokens, user_settings, account, "session", verification, "user" RESTART IDENTITY CASCADE`;
  await sql.end({ timeout: 1 });
}

async function startApp(authEnabled = false) {
  app = await createApp({ authEnabled, logger: false, serveWeb: false, startBackground: false });
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
    vi.restoreAllMocks();
    await Promise.all(runners.splice(0).map((runner) => runner.close()));
    await app?.close();
    app = null;
    await closeDb();
  });

  it('executes a condition branch and skips only the rejected path', async () => {
    const defId = 'workflow-condition-kernel-st';
    const graph = {
      name: 'Condition kernel ST',
      nodes: [
        { id: 'choose', type: 'condition', expr: 'vars.release == "yes"', onTrue: ['approve'], onFalse: ['reject'] },
        { id: 'approve', type: 'gate', title: 'Approve path' },
        { id: 'reject', type: 'gate', title: 'Reject path' },
      ],
      edges: [['choose', 'approve'], ['choose', 'reject']],
    };
    await getDb().insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });

    const started = await app!.inject({
      method: 'POST',
      url: `/api/workflows/${defId}/runs`,
      payload: { vars: { release: 'yes' } },
    });
    expect(started.statusCode).toBe(201);
    const { runId } = started.json<{ runId: string }>();

    await vi.waitFor(async () => {
      const states = await getDb().select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
      expect(Object.fromEntries(states.map((state) => [state.nodeId, state.status]))).toMatchObject({
        choose: 'done',
        approve: 'waiting_human',
        reject: 'skipped',
      });
    });
  });

  it('fans out structured items into parallel agents and aggregates their outputs', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true }),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-fanout-kernel', name: 'Fanout Kernel Runner', labels: ['fanout-kernel'], resources: [], startedAt: Date.now() },
    });
    const defId = 'workflow-fanout-kernel-st';
    const graph = {
      name: 'Fanout kernel ST',
      nodes: [{
        id: 'work',
        type: 'fanout',
        itemsFrom: 'vars.items',
        maxItems: 4,
        template: {
          prompt: 'Handle {{item.name}} at index {{index}}',
          machine: { labels: ['fanout-kernel'] },
          cwd: '/tmp/fanout-kernel',
        },
      }],
      edges: [],
    };
    await getDb().insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    const started = await app!.inject({
      method: 'POST',
      url: `/api/workflows/${defId}/runs`,
      payload: { vars: { items: JSON.stringify([{ name: 'alpha' }, { name: 'beta' }]) } },
    });
    const { runId } = started.json<{ runId: string }>();
    await vi.waitFor(() => {
      expect(runner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(2);
    });
    const spawns = runner.calls.filter((call) => call.method === 'session.spawn');
    expect(spawns.map((call) => (call.params as { prompt: string }).prompt).sort()).toEqual([
      'Handle alpha at index 0',
      'Handle beta at index 1',
    ]);
    const stopEngine = startEngine();
    try {
      for (const [index, call] of spawns.entries()) {
        const sessionId = (call.params as { sessionId: string }).sessionId;
        await runner.callServer('session.event', {
          sessionId,
          envelope: { id: `fanout-text-${index}`, time: Date.now(), role: 'agent', ev: { t: 'text', text: `result-${index}` } },
        });
        await runner.callServer('session.event', {
          sessionId,
          envelope: { id: `fanout-end-${index}`, time: Date.now(), role: 'agent', ev: { t: 'turn-end', status: 'completed' } },
        });
      }
      await vi.waitFor(async () => {
        const [state] = await getDb().select().from(schema.nodeStates).where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, 'work')));
        expect(state?.status, JSON.stringify(state?.output)).toBe('done');
        expect((state?.output as { children: Array<{ status: string }> }).children.every((child) => child.status === 'done')).toBe(true);
        const [run] = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
        expect(run?.status).toBe('done');
        expect(JSON.parse((run?.context as { outputs: Record<string, string> }).outputs.work!)).toHaveLength(2);
      });
    } finally {
      stopEngine();
    }
  });

  it('recovers a persisted multi-agent meeting and concludes after restart', async () => {
    const runner = await FakeRunner.connect(baseUrl);
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-meeting-recovery', name: 'Meeting Recovery Runner', labels: [], resources: [], startedAt: Date.now() },
    });
    const defId = 'workflow-meeting-recovery-st';
    const runId = 'run-meeting-recovery-st';
    const graph = {
      name: 'Meeting recovery ST',
      nodes: [{
        id: 'review',
        type: 'meeting',
        participants: [{ model: 'model-a', role: 'reviewer-a' }, { model: 'model-b', role: 'reviewer-b' }],
        arbiter: 'vote',
        subject: 'Review release',
      }],
      edges: [],
    };
    await getDb().insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await getDb().insert(schema.workflowRuns).values({ id: runId, defId, status: 'running', context: { vars: {}, outputs: {} } });
    const sessionIds = ['meeting-recovery-a', 'meeting-recovery-b'];
    await getDb().insert(schema.sessions).values(sessionIds.map((id) => ({
      id,
      machineId: 'm-meeting-recovery',
      agent: 'claude',
      cwd: '/tmp/meeting-recovery',
      state: 'idle',
      runId,
      nodeId: 'review',
    })));
    await getDb().insert(schema.nodeStates).values({
      runId,
      nodeId: 'review',
      status: 'running',
      output: {
        kind: 'meeting',
        phase: 'review',
        title: 'Release review',
        cwd: '/tmp/meeting-recovery',
        opinions: [null, null],
        sessions: sessionIds.map((sessionId, idx) => ({ sessionId, idx, status: 'running' })),
      },
    });

    const stopEngine = startEngine();
    try {
      await resumeActiveRuns();
      for (const [index, sessionId] of sessionIds.entries()) {
        await runner.callServer('session.event', {
          sessionId,
          envelope: {
            id: `meeting-verdict-${index}`,
            time: Date.now(),
            role: 'agent',
            ev: { t: 'text', text: `Looks good\n\n{"verdict":"approve","score":9,"reasons":["ready"]}` },
          },
        });
        await runner.callServer('session.event', {
          sessionId,
          envelope: { id: `meeting-end-${index}`, time: Date.now(), role: 'agent', ev: { t: 'turn-end', status: 'completed' } },
        });
      }
      await vi.waitFor(async () => {
        const [state] = await getDb().select().from(schema.nodeStates).where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, 'review')));
        expect(state?.status).toBe('done');
        expect(state?.output).toMatchObject({ verdict: 'approve' });
        const [run] = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
        expect(run?.status).toBe('done');
      });
    } finally {
      stopEngine();
    }
  });

  it('cancels queued agent work atomically with its workflow run', async () => {
    const defId = 'workflow-cancel-queue-st';
    const runId = 'run-cancel-queue-st';
    const graph = { name: 'Cancel queue ST', nodes: [{ id: 'gate', type: 'gate' }], edges: [] };
    await getDb().insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await getDb().insert(schema.workflowRuns).values({ id: runId, defId, status: 'running', context: { vars: {}, outputs: {} } });
    await getDb().insert(schema.nodeStates).values({ runId, nodeId: 'gate', status: 'pending' });
    await getDb().insert(schema.taskQueue).values([
      { id: 'queued-for-run', status: 'pending', payload: { runId, sessionId: 'queued-session-a' } },
      { id: 'scheduled-for-run', status: 'scheduled', payload: { runId, sessionId: 'queued-session-b' } },
      { id: 'other-run-task', status: 'pending', payload: { runId: 'other-run' } },
    ]);

    const cancelled = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ ok: true, cancelledQueuedTasks: 2 });
    const [run] = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(run?.status).toBe('cancelled');
    const tasks = await getDb().select().from(schema.taskQueue);
    expect(Object.fromEntries(tasks.map((task) => [task.id, task.status]))).toMatchObject({
      'queued-for-run': 'cancelled',
      'scheduled-for-run': 'cancelled',
      'other-run-task': 'pending',
    });
  });

  it('publishes a workflow revision and atomically moves future references without changing existing runs', async () => {
    const db = getDb();
    const sourceId = 'workflow-revision-v1';
    const projectId = 'workflow-revision-project';
    const triggerId = 'workflow-revision-trigger';
    const runId = 'workflow-revision-existing-run';
    const sourceGraph = {
      name: 'Release pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Implement the release' }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({
      id: sourceId,
      name: sourceGraph.name,
      version: 1,
      graph: sourceGraph,
      projectId,
    });
    await db.insert(schema.projects).values({
      id: projectId,
      name: 'Workflow revision ST',
      forge: 'github',
      repo: 'example/workflow-revision',
      defaultWorkflow: sourceId,
      defaultDefId: sourceId,
    });
    await db.insert(schema.requirementTriggers).values({
      id: triggerId,
      projectId,
      forge: 'github',
      repo: 'example/workflow-revision',
      defId: sourceId,
    });
    await db.insert(schema.workflowRuns).values({ id: runId, defId: sourceId, projectId });

    const revisedGraph = {
      name: 'Release pipeline',
      nodes: [
        { id: 'implement', type: 'agent', prompt: 'Implement the release' },
        { id: 'verify', type: 'check', critic: { kind: 'command', run: 'pnpm test' } },
      ],
      edges: [['implement', 'verify']],
    };
    const response = await app!.inject({
      method: 'POST',
      url: `/api/workflows/${sourceId}/revisions`,
      payload: { graph: revisedGraph, createdVia: 'chat' },
    });

    expect(response.statusCode).toBe(201);
    const revision = response.json() as { id: string; name: string; version: number; previousId: string };
    expect(revision).toMatchObject({ name: revisedGraph.name, version: 2, previousId: sourceId });
    expect(revision.id).not.toBe(sourceId);

    const [source] = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, sourceId));
    const [next] = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, revision.id));
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const [trigger] = await db.select().from(schema.requirementTriggers).where(eq(schema.requirementTriggers.id, triggerId));
    const [run] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));

    expect(source).toMatchObject({ id: sourceId, version: 1, archived: 'yes', graph: sourceGraph });
    expect(next).toMatchObject({
      id: revision.id,
      version: 2,
      archived: 'no',
      projectId,
      createdVia: 'chat',
      graph: revisedGraph,
    });
    expect(project).toMatchObject({ defaultWorkflow: revision.id, defaultDefId: revision.id });
    expect(trigger).toMatchObject({ defId: revision.id });
    expect(run).toMatchObject({ id: runId, defId: sourceId });
  });

  it('leaves workflow records and references unchanged when a revision graph is invalid', async () => {
    const db = getDb();
    const sourceId = 'workflow-invalid-v1';
    const projectId = 'workflow-invalid-project';
    const triggerId = 'workflow-invalid-trigger';
    const runId = 'workflow-invalid-existing-run';
    const sourceGraph = {
      name: 'Guarded pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Implement safely' }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({
      id: sourceId,
      name: sourceGraph.name,
      graph: sourceGraph,
      projectId,
    });
    await db.insert(schema.projects).values({
      id: projectId,
      name: 'Invalid workflow revision ST',
      forge: 'github',
      repo: 'example/invalid-workflow-revision',
      defaultWorkflow: sourceId,
      defaultDefId: sourceId,
    });
    await db.insert(schema.requirementTriggers).values({
      id: triggerId,
      projectId,
      forge: 'github',
      repo: 'example/invalid-workflow-revision',
      defId: sourceId,
    });
    await db.insert(schema.workflowRuns).values({ id: runId, defId: sourceId, projectId });

    const response = await app!.inject({
      method: 'POST',
      url: `/api/workflows/${sourceId}/revisions`,
      payload: {
        graph: { ...sourceGraph, edges: [['implement', 'missing-node']] },
        createdVia: 'chat',
      },
    });

    expect(response.statusCode).toBe(400);
    const definitions = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.projectId, projectId));
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const [trigger] = await db.select().from(schema.requirementTriggers).where(eq(schema.requirementTriggers.id, triggerId));
    const [run] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ id: sourceId, version: 1, archived: 'no', graph: sourceGraph });
    expect(project).toMatchObject({ defaultWorkflow: sourceId, defaultDefId: sourceId });
    expect(trigger).toMatchObject({ defId: sourceId });
    expect(run).toMatchObject({ id: runId, defId: sourceId });
  });

  it('atomically starts one workflow run for a recorded issue intake', async () => {
    const db = getDb();
    const projectId = 'manual-intake-project';
    const defId = 'manual-intake-workflow';
    const triggerId = 'manual-intake-trigger';
    const intakeId = 'manual-intake';
    const graph = {
      name: 'Manual intake pipeline',
      nodes: [{ id: 'review', type: 'gate' }],
      edges: [],
    };
    await db.insert(schema.projects).values({
      id: projectId,
      name: 'Manual intake ST',
      forge: 'github',
      repo: 'example/manual-intake',
      vars: { team: 'project', priority: 'project' },
    });
    await db.insert(schema.workflowDefs).values({
      id: defId,
      name: graph.name,
      graph,
      projectId,
    });
    await db.insert(schema.requirementTriggers).values({
      id: triggerId,
      projectId,
      forge: 'github',
      repo: 'example/manual-intake',
      defId,
      vars: { priority: 'trigger' },
    });
    await db.insert(schema.requirementIntakes).values({
      id: intakeId,
      triggerId,
      projectId,
      forge: 'github',
      repo: 'example/manual-intake',
      issueNumber: '73',
      title: 'Seeded issue',
      author: 'seed-author',
      issueUrl: 'https://github.com/example/manual-intake/issues/73',
      status: 'seeded',
    });
    const getIssue = vi.spyOn(getForge('github'), 'getIssue').mockResolvedValue({
      number: '73',
      title: 'Launch recorded intake',
      body: 'Use the original issue body',
      state: 'open',
      labels: ['automation'],
      author: 'issue-author',
      htmlUrl: 'https://github.com/example/manual-intake/issues/73',
    });

    const responses = await Promise.all([
      app!.inject({ method: 'POST', url: `/api/requirements/${intakeId}/start` }),
      app!.inject({ method: 'POST', url: `/api/requirements/${intakeId}/start` }),
    ]);
    const success = responses.find((response) => response.statusCode === 201);
    const conflict = responses.find((response) => response.statusCode === 409);

    expect(success).toBeDefined();
    expect(conflict?.json()).toMatchObject({ error: expect.stringContaining('already') });
    const { runId } = success!.json() as { runId: string };
    const [intake] = await db.select().from(schema.requirementIntakes).where(eq(schema.requirementIntakes.id, intakeId));
    const runs = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.defId, defId));
    await vi.waitFor(async () => {
      const [node] = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
      expect(node?.status).toBe('waiting_human');
    });
    const nodes = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));

    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(intake).toMatchObject({ status: 'started', runId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, projectId });
    expect(runs[0]?.context).toMatchObject({
      vars: {
        team: 'project',
        priority: 'trigger',
        forge: 'github',
        repo: 'example/manual-intake',
        issue_number: '73',
        issue_title: 'Launch recorded intake',
        issue_body: 'Use the original issue body',
        issue_author: 'issue-author',
      },
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ runId, nodeId: 'review', status: 'waiting_human' });
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

  it('pages backward through persisted session events without gaps or duplicates', async () => {
    const db = getDb();
    await db.insert(schema.machines).values({ id: 'm-history', name: 'History Runner' });
    await db.insert(schema.sessions).values({
      id: 'session-history-st',
      machineId: 'm-history',
      agent: 'claude',
      cwd: '/tmp/history-work',
      state: 'idle',
    });
    const inserted = await db
      .insert(schema.events)
      .values(
        Array.from({ length: 4001 }, (_, index) => ({
          sessionId: 'session-history-st',
          type: 'session.message',
          payload: { index: index + 1 },
        })),
      )
      .returning({ seq: schema.events.seq });
    const allSeqs = inserted.map((row) => row.seq).sort((left, right) => left - right);

    type EventPage = {
      events: Array<{ seq: number }>;
      page: { hasEarlier: boolean; before: number | null };
    };
    const getPage = async (suffix = '') => {
      const response = await app!.inject({
        method: 'GET',
        url: `/api/sessions/session-history-st/events${suffix}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json<EventPage>();
    };

    const newest = await getPage();
    expect(newest.events.map((event) => event.seq)).toEqual(allSeqs.slice(2001));
    expect(newest.page).toEqual({ hasEarlier: true, before: allSeqs[2001] });

    const middle = await getPage(`?before=${newest.page.before}`);
    expect(middle.events.map((event) => event.seq)).toEqual(allSeqs.slice(1, 2001));
    expect(middle.page).toEqual({ hasEarlier: true, before: allSeqs[1] });

    const oldest = await getPage(`?before=${middle.page.before}`);
    expect(oldest.events.map((event) => event.seq)).toEqual(allSeqs.slice(0, 1));
    expect(oldest.page).toEqual({ hasEarlier: false, before: null });

    const pagedSeqs = [...oldest.events, ...middle.events, ...newest.events].map((event) => event.seq);
    expect(pagedSeqs).toEqual(allSeqs);
    expect(new Set(pagedSeqs).size).toBe(allSeqs.length);

    const [live] = await db
      .insert(schema.events)
      .values({ sessionId: 'session-history-st', type: 'session.state', payload: { state: 'thinking' } })
      .returning({ seq: schema.events.seq });
    const forward = await getPage(`?since=${allSeqs[allSeqs.length - 1]}`);
    expect(forward.events.map((event) => event.seq)).toEqual([live!.seq]);
  });

  it('pages backward through mixed run and linked-session events without gaps or duplicates', async () => {
    const db = getDb();
    const defId = 'workflow-run-history-def';
    const runId = 'workflow-run-history-st';
    const sessionIds = ['run-history-session-a', 'run-history-session-b'];
    const graph = {
      name: 'Auditable pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Implement the change' }],
      edges: [],
    };
    await db.insert(schema.machines).values({ id: 'm-run-history', name: 'Run History Runner' });
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await db.insert(schema.workflowRuns).values({ id: runId, defId });
    await db.insert(schema.sessions).values(sessionIds.map((id, index) => ({
      id,
      machineId: 'm-run-history',
      agent: 'claude',
      cwd: `/tmp/run-history-${index}`,
      state: 'dead',
      runId,
      nodeId: `node-${index}`,
    })));
    await db.insert(schema.events).values({
      runId: 'another-run',
      type: 'run.started',
      payload: { marker: 'unrelated-before' },
    });

    const runEventTypes = ['run.node.state', 'approval.requested', 'forge.ci'] as const;
    const inserted = await db
      .insert(schema.events)
      .values(Array.from({ length: 4005 }, (_, index) => index % 2 === 0
        ? {
            runId,
            type: runEventTypes[index % runEventTypes.length]!,
            payload: { index: index + 1, source: 'run' },
          }
        : {
            sessionId: sessionIds[Math.floor(index / 2) % sessionIds.length]!,
            type: 'session.message',
            payload: { index: index + 1, source: 'session' },
          }))
      .returning({ seq: schema.events.seq });
    const allSeqs = inserted.map((row) => row.seq).sort((left, right) => left - right);
    await db.insert(schema.events).values({
      sessionId: 'unlinked-session',
      type: 'session.message',
      payload: { marker: 'unrelated-after' },
    });

    type RunThreadPage = {
      events: Array<{ seq: number; type: string }>;
      page: { hasEarlier: boolean; before: number | null };
    };
    const getPage = async (suffix = '') => {
      const response = await app!.inject({
        method: 'GET',
        url: `/api/runs/${runId}/thread${suffix}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json<RunThreadPage>();
    };

    const newest = await getPage();
    expect(newest.events.map((event) => event.seq)).toEqual(allSeqs.slice(2005));
    expect(newest.page).toEqual({ hasEarlier: true, before: allSeqs[2005] });

    const middle = await getPage(`?before=${newest.page.before}`);
    expect(middle.events.map((event) => event.seq)).toEqual(allSeqs.slice(5, 2005));
    expect(middle.page).toEqual({ hasEarlier: true, before: allSeqs[5] });

    const oldest = await getPage(`?before=${middle.page.before}`);
    expect(oldest.events.map((event) => event.seq)).toEqual(allSeqs.slice(0, 5));
    expect(oldest.page).toEqual({ hasEarlier: false, before: null });

    const pagedEvents = [...oldest.events, ...middle.events, ...newest.events];
    const pagedSeqs = pagedEvents.map((event) => event.seq);
    expect(pagedSeqs).toEqual(allSeqs);
    expect(new Set(pagedSeqs).size).toBe(allSeqs.length);
    expect(new Set(pagedEvents.map((event) => event.type))).toEqual(new Set([
      'run.node.state',
      'approval.requested',
      'forge.ci',
      'session.message',
    ]));

    const [live] = await db
      .insert(schema.events)
      .values({ sessionId: sessionIds[0], type: 'session.message', payload: { marker: 'live' } })
      .returning({ seq: schema.events.seq });
    const forward = await getPage(`?since=${allSeqs[allSeqs.length - 1]}`);
    expect(forward.events.map((event) => event.seq)).toEqual([live!.seq]);
    expect(forward.page).toEqual({ hasEarlier: false, before: null });
  });

  it('searches persisted message content across archived sessions and workflow runs within one project', async () => {
    const db = getDb();
    const archivedAt = new Date('2026-07-13T08:00:00Z');
    await db.insert(schema.projects).values([
      { id: 'search-project-1', name: 'Search project', forge: 'github', repo: 'example/search' },
      { id: 'search-project-2', name: 'Other project', forge: 'github', repo: 'example/other' },
    ]);
    await db.insert(schema.machines).values({ id: 'm-conversation-search', name: 'Search Runner' });
    await db.insert(schema.workflowDefs).values({
      id: 'search-workflow-def',
      name: 'Release verification',
      projectId: 'search-project-1',
      graph: { name: 'Release verification', nodes: [{ id: 'verify', type: 'agent', prompt: 'Verify' }], edges: [] },
    });
    await db.insert(schema.workflowRuns).values({
      id: 'search-workflow-run',
      defId: 'search-workflow-def',
      projectId: 'search-project-1',
      status: 'done',
      archivedAt,
    });
    await db.insert(schema.sessions).values([
      {
        id: 'search-standalone-session',
        machineId: 'm-conversation-search',
        agent: 'claude',
        cwd: '/tmp/search-standalone',
        title: 'Archived investigation',
        state: 'dead',
        projectId: 'search-project-1',
        archivedAt,
      },
      {
        id: 'search-workflow-session',
        machineId: 'm-conversation-search',
        agent: 'claude',
        cwd: '/tmp/search-workflow',
        state: 'dead',
        projectId: 'search-project-1',
        runId: 'search-workflow-run',
        nodeId: 'verify',
      },
      {
        id: 'search-other-project-session',
        machineId: 'm-conversation-search',
        agent: 'claude',
        cwd: '/tmp/search-other',
        state: 'dead',
        projectId: 'search-project-2',
      },
    ]);
    await db.insert(schema.events).values([
      {
        sessionId: 'search-standalone-session',
        type: 'session.message',
        payload: { id: 'm1', time: 1, role: 'user', ev: { t: 'text', text: 'Please investigate the lunar handshake failure.' } },
      },
      {
        // Historical child-session messages may not carry run_id; association must come from sessions.run_id.
        sessionId: 'search-workflow-session',
        type: 'session.message',
        payload: { id: 'm2', time: 2, role: 'agent', ev: { t: 'text', text: 'The LUNAR handshake is fixed in the workflow.' } },
      },
      {
        sessionId: 'search-other-project-session',
        type: 'session.message',
        payload: { id: 'm3', time: 3, role: 'agent', ev: { t: 'text', text: 'A lunar handshake exists in another project.' } },
      },
      {
        sessionId: 'search-standalone-session',
        type: 'session.message',
        payload: { id: 'm4', time: 4, role: 'agent', ev: { t: 'text', text: 'Thinking about the lunar handshake internals.', thinking: true } },
      },
    ]);

    const response = await app!.inject({
      method: 'GET',
      url: '/api/conversations/search?q=lunar%20handshake&projectId=search-project-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ results: Array<Record<string, unknown>> }>().results).toEqual([
      expect.objectContaining({
        kind: 'run',
        id: 'search-workflow-run',
        sessionId: 'search-workflow-session',
        title: 'Release verification',
        role: 'agent',
        archived: true,
        projectId: 'search-project-1',
        snippet: expect.stringContaining('LUNAR handshake'),
      }),
      expect.objectContaining({
        kind: 'session',
        id: 'search-standalone-session',
        title: 'Archived investigation',
        role: 'user',
        archived: true,
        projectId: 'search-project-1',
        snippet: expect.stringContaining('lunar handshake'),
      }),
    ]);
  });

  it('persists trimmed session titles and rejects invalid or unknown renames', async () => {
    const db = getDb();
    await db.insert(schema.machines).values({ id: 'm-rename', name: 'Rename Runner' });
    await db.insert(schema.sessions).values({
      id: 'session-rename-st',
      machineId: 'm-rename',
      agent: 'claude',
      cwd: '/tmp/rename-work',
      title: 'Original title',
      state: 'idle',
    });

    const renamed = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-rename-st',
      payload: { title: '  Incident follow-up  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({
      ok: true,
      session: { id: 'session-rename-st', title: 'Incident follow-up' },
    });

    const [persisted] = await db
      .select({ title: schema.sessions.title })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, 'session-rename-st'));
    expect(persisted?.title).toBe('Incident follow-up');
    const listed = await app!.inject({ method: 'GET', url: '/api/sessions' });
    expect(listed.json()).toMatchObject({
      sessions: [{ id: 'session-rename-st', title: 'Incident follow-up' }],
    });

    const invalid = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-rename-st',
      payload: { title: '   ' },
    });
    expect(invalid.statusCode).toBe(400);
    const [unchanged] = await db
      .select({ title: schema.sessions.title })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, 'session-rename-st'));
    expect(unchanged?.title).toBe('Incident follow-up');

    const missing = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/missing-session',
      payload: { title: 'Still valid' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'session not found: missing-session' });
  });

  it('reads active, archived, and older sessions by exact ID outside the sidebar list window', async () => {
    const db = getDb();
    await db.insert(schema.machines).values({ id: 'm-deep-link', name: 'Deep Link Runner' });
    const recentSessions = Array.from({ length: 100 }, (_, index) => ({
      id: `session-deep-link-recent-${index.toString().padStart(3, '0')}`,
      machineId: 'm-deep-link',
      agent: 'claude',
      cwd: `/tmp/deep-link-recent-${index}`,
      state: 'dead',
      createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, index)),
    }));
    await db.insert(schema.sessions).values([
      {
        id: 'session-deep-link-older',
        machineId: 'm-deep-link',
        agent: 'claude',
        cwd: '/tmp/deep-link-older',
        title: 'Older conversation',
        state: 'dead',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
      {
        id: 'session-deep-link-active',
        machineId: 'm-deep-link',
        agent: 'claude',
        cwd: '/tmp/deep-link-active',
        title: 'Active conversation',
        state: 'idle',
        createdAt: new Date('2026-07-11T00:00:00.000Z'),
      },
      {
        id: 'session-deep-link-archived',
        machineId: 'm-deep-link',
        agent: 'claude',
        cwd: '/tmp/deep-link-archived',
        title: 'Archived conversation',
        state: 'dead',
        archivedAt: new Date('2026-07-09T00:00:00.000Z'),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      ...recentSessions,
    ]);

    const listed = await app!.inject({ method: 'GET', url: '/api/sessions' });
    const listedIds = listed.json<{ sessions: Array<{ id: string }> }>().sessions.map((session) => session.id);
    expect(listedIds).toHaveLength(100);
    expect(listedIds).toContain('session-deep-link-active');
    expect(listedIds).not.toContain('session-deep-link-older');
    expect(listedIds).not.toContain('session-deep-link-archived');

    const [active, archived, older] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/sessions/session-deep-link-active' }),
      app!.inject({ method: 'GET', url: '/api/sessions/session-deep-link-archived' }),
      app!.inject({ method: 'GET', url: '/api/sessions/session-deep-link-older' }),
    ]);
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      session: { id: 'session-deep-link-active', state: 'idle', archivedAt: null },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      session: { id: 'session-deep-link-archived', state: 'dead', archivedAt: expect.any(String) },
    });
    expect(older.statusCode).toBe(200);
    expect(older.json()).toMatchObject({
      session: { id: 'session-deep-link-older', title: 'Older conversation', archivedAt: null },
    });
  });

  it('archives and restores a finished manual session without changing its transcript', async () => {
    const db = getDb();
    await db.insert(schema.machines).values({ id: 'm-archive', name: 'Archive Runner' });
    await db.insert(schema.sessions).values([
      {
        id: 'session-archive-st',
        machineId: 'm-archive',
        agent: 'claude',
        cwd: '/tmp/archive-work',
        title: 'Finished conversation',
        state: 'dead',
      },
      {
        id: 'session-archive-active',
        machineId: 'm-archive',
        agent: 'claude',
        cwd: '/tmp/active-work',
        state: 'idle',
      },
      {
        id: 'session-archive-workflow',
        machineId: 'm-archive',
        agent: 'claude',
        cwd: '/tmp/workflow-work',
        state: 'dead',
        runId: 'run-archive-owner',
      },
    ]);
    await db.insert(schema.events).values([
      { sessionId: 'session-archive-st', type: 'session.created', payload: { marker: 'created' } },
      { sessionId: 'session-archive-st', type: 'session.message', payload: { marker: 'retained transcript' } },
    ]);

    const archived = await app!.inject({ method: 'POST', url: '/api/sessions/session-archive-st/archive' });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      ok: true,
      session: { id: 'session-archive-st', archivedAt: expect.any(String) },
    });

    const [persisted] = await db
      .select({ archivedAt: schema.sessions.archivedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, 'session-archive-st'));
    expect(persisted?.archivedAt).toBeInstanceOf(Date);

    const defaultList = await app!.inject({ method: 'GET', url: '/api/sessions' });
    const defaultSessions = defaultList.json<{ sessions: Array<{ id: string }> }>().sessions;
    expect(defaultSessions.map((session) => session.id)).not.toContain('session-archive-st');

    const archivedList = await app!.inject({ method: 'GET', url: '/api/sessions?archived=true' });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json()).toMatchObject({
      sessions: [{ id: 'session-archive-st', state: 'dead', archivedAt: expect.any(String) }],
    });

    const transcriptWhileArchived = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-archive-st/events',
    });
    expect(
      transcriptWhileArchived
        .json<{ events: Array<{ type: string; payload: unknown }> }>()
        .events.map((event) => ({ type: event.type, payload: event.payload })),
    ).toEqual([
      { type: 'session.created', payload: { marker: 'created' } },
      { type: 'session.message', payload: { marker: 'retained transcript' } },
    ]);

    const active = await app!.inject({ method: 'POST', url: '/api/sessions/session-archive-active/archive' });
    const workflow = await app!.inject({ method: 'POST', url: '/api/sessions/session-archive-workflow/archive' });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ error: expect.stringContaining('still active') });
    expect(workflow.statusCode).toBe(409);
    expect(workflow.json()).toMatchObject({ error: expect.stringContaining('workflow') });

    const restored = await app!.inject({ method: 'POST', url: '/api/sessions/session-archive-st/restore' });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({
      ok: true,
      session: { id: 'session-archive-st', archivedAt: null },
    });

    const historyList = await app!.inject({ method: 'GET', url: '/api/sessions' });
    expect(historyList.json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: 'session-archive-st', state: 'dead', archivedAt: null }),
      ]),
    });
    const emptyArchive = await app!.inject({ method: 'GET', url: '/api/sessions?archived=true' });
    expect(emptyArchive.json()).toEqual({ sessions: [] });
  });

  it('persists a workflow run title across list, detail, thread, and server reloads', async () => {
    const db = getDb();
    const defId = 'workflow-run-title-def';
    const runId = 'workflow-run-title-st';
    const graph = {
      name: 'Release pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Ship the release' }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await db.insert(schema.workflowRuns).values({ id: runId, defId });

    const renamed = await app!.inject({
      method: 'PATCH',
      url: `/api/runs/${runId}`,
      payload: { title: '  Production rollout  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ ok: true, run: { id: runId, title: 'Production rollout' } });

    const [persisted] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(persisted?.title).toBe('Production rollout');

    await app!.close();
    app = null;
    await closeDb();
    await startApp();

    const list = await app!.inject({ method: 'GET', url: '/api/runs' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      runs: [expect.objectContaining({ id: runId, title: 'Production rollout', defName: 'Release pipeline' })],
    });

    const detail = await app!.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ run: { id: runId, title: 'Production rollout' } });

    const thread = await app!.inject({ method: 'GET', url: `/api/runs/${runId}/thread` });
    expect(thread.statusCode).toBe(200);
    expect(thread.json()).toMatchObject({ run: { id: runId, title: 'Production rollout' } });

    for (const payload of [
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { title: 'Unexpected field', extra: true },
      {},
    ]) {
      const invalid = await app!.inject({ method: 'PATCH', url: `/api/runs/${runId}`, payload });
      expect(invalid.statusCode).toBe(400);
    }

    const missing = await app!.inject({
      method: 'PATCH',
      url: '/api/runs/missing-run',
      payload: { title: 'Missing run title' },
    });
    expect(missing.statusCode).toBe(404);

    const [unchanged] = await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(unchanged?.title).toBe('Production rollout');
  });

  it('persists pin state for top-level sessions and workflow runs across REST lists and reloads', async () => {
    const db = getDb();
    const projectId = 'pinning-project';
    const defId = 'pinning-workflow';
    const sessionId = 'pinning-session';
    const runId = 'pinning-run';
    await db.insert(schema.projects).values({
      id: projectId,
      name: 'Pinned operations',
      forge: 'github',
      repo: 'example/pinned-operations',
    });
    await db.insert(schema.machines).values({ id: 'pinning-machine', name: 'Pinning Runner' });
    await db.insert(schema.workflowDefs).values({
      id: defId,
      name: 'Pinned workflow',
      projectId,
      graph: { name: 'Pinned workflow', nodes: [], edges: [] },
    });
    await db.insert(schema.sessions).values([
      {
        id: sessionId,
        machineId: 'pinning-machine',
        agent: 'claude',
        cwd: '/tmp/pinning-session',
        projectId,
        state: 'idle',
      },
      {
        id: 'pinning-child-session',
        machineId: 'pinning-machine',
        agent: 'claude',
        cwd: '/tmp/pinning-child',
        projectId,
        runId,
        state: 'idle',
      },
      {
        id: 'pinning-archived-session',
        machineId: 'pinning-machine',
        agent: 'claude',
        cwd: '/tmp/pinning-archived',
        projectId,
        state: 'dead',
        archivedAt: new Date('2026-07-14T01:00:00Z'),
      },
    ]);
    await db.insert(schema.workflowRuns).values([
      { id: runId, defId, projectId },
      {
        id: 'pinning-archived-run',
        defId,
        projectId,
        status: 'done',
        endedAt: new Date('2026-07-14T01:00:00Z'),
        archivedAt: new Date('2026-07-14T02:00:00Z'),
      },
    ]);

    const [pinnedSession, pinnedRun] = await Promise.all([
      app!.inject({ method: 'PATCH', url: `/api/sessions/${sessionId}`, payload: { pinned: true } }),
      app!.inject({ method: 'PATCH', url: `/api/runs/${runId}`, payload: { pinned: true } }),
    ]);
    expect(pinnedSession.statusCode).toBe(200);
    expect(pinnedSession.json()).toMatchObject({
      ok: true,
      session: { id: sessionId, pinnedAt: expect.any(String) },
    });
    expect(pinnedRun.statusCode).toBe(200);
    expect(pinnedRun.json()).toMatchObject({
      ok: true,
      run: { id: runId, pinnedAt: expect.any(String) },
    });

    const [persistedSession] = await db.select({ pinnedAt: schema.sessions.pinnedAt })
      .from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    const [persistedRun] = await db.select({ pinnedAt: schema.workflowRuns.pinnedAt })
      .from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(persistedSession?.pinnedAt).toBeInstanceOf(Date);
    expect(persistedRun?.pinnedAt).toBeInstanceOf(Date);

    for (const [url, payload] of [
      ['/api/sessions/pinning-child-session', { pinned: true }],
      ['/api/sessions/pinning-archived-session', { pinned: true }],
      ['/api/runs/pinning-archived-run', { pinned: true }],
    ] as const) {
      const rejected = await app!.inject({ method: 'PATCH', url, payload });
      expect(rejected.statusCode).toBe(409);
    }

    await app!.close();
    app = null;
    await closeDb();
    await startApp();

    const [sessionsList, runsList] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/sessions' }),
      app!.inject({ method: 'GET', url: '/api/runs' }),
    ]);
    expect(sessionsList.json()).toMatchObject({
      sessions: [expect.objectContaining({ id: sessionId, projectId, pinnedAt: expect.any(String) })],
    });
    expect(runsList.json()).toMatchObject({
      runs: [expect.objectContaining({ id: runId, projectId, pinnedAt: expect.any(String) })],
    });

    const [unpinnedSession, unpinnedRun] = await Promise.all([
      app!.inject({ method: 'PATCH', url: `/api/sessions/${sessionId}`, payload: { pinned: false } }),
      app!.inject({ method: 'PATCH', url: `/api/runs/${runId}`, payload: { pinned: false } }),
    ]);
    expect(unpinnedSession.json()).toEqual({ ok: true, session: { id: sessionId, pinnedAt: null } });
    expect(unpinnedRun.json()).toEqual({ ok: true, run: { id: runId, pinnedAt: null } });

    const [unpersistedSession] = await getDb().select({ pinnedAt: schema.sessions.pinnedAt })
      .from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    const [unpersistedRun] = await getDb().select({ pinnedAt: schema.workflowRuns.pinnedAt })
      .from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(unpersistedSession?.pinnedAt).toBeNull();
    expect(unpersistedRun?.pinnedAt).toBeNull();
  });

  it('persists operator notes from REST to the live and reloaded run thread without runner dispatch', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const email = 'run-note-operator@example.com';
    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Run Note Operator', email, password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    expect(cookie).not.toBe('');

    const runner = await FakeRunner.connect(baseUrl);
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-run-note',
        name: 'Run Note Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });

    const db = getDb();
    const defId = 'workflow-run-note-def';
    const runId = 'workflow-run-note-st';
    const sessionId = 'workflow-run-note-session';
    const graph = {
      name: 'Run note pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Ship the release' }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await db.insert(schema.workflowRuns).values({ id: runId, defId, status: 'running' });
    await db.insert(schema.sessions).values({
      id: sessionId,
      machineId: 'm-run-note',
      agent: 'claude',
      cwd: '/tmp/run-note-work',
      state: 'thinking',
      runId,
      nodeId: 'implement',
    });
    await db.insert(schema.nodeStates).values({
      runId,
      nodeId: 'implement',
      status: 'running',
      sessionId,
    });

    const client = await connectRunEvents(baseUrl, runId, cookie);
    const markdown = '**Hold** deployment until the change window opens.';
    try {
      const liveNote = waitForClientEvent(client, (event) => event.type === 'run.note');
      const runnerCallsBeforeNote = runner.calls.length;
      const created = await app!.inject({
        method: 'POST',
        url: `/api/runs/${runId}/notes`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: `  ${markdown}  ` },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        note: {
          seq: expect.any(Number),
          type: 'run.note',
          runId,
          payload: { markdown, author: email },
        },
      });
      await expect(liveNote).resolves.toMatchObject({
        type: 'run.note',
        runId,
        payload: { markdown, author: email },
      });
      const noteId = created.json().note.seq as number;
      const revisedMarkdown = '**Proceed** during the approved change window.';
      const liveRevision = waitForClientEvent(client, (event) => event.type === 'run.note.updated');
      const revised = await app!.inject({
        method: 'PATCH',
        url: `/api/runs/${runId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: `  ${revisedMarkdown}  ` },
      });
      expect(revised.statusCode).toBe(200);
      expect(revised.json()).toMatchObject({
        note: { type: 'run.note.updated', runId, payload: { noteId, markdown: revisedMarkdown } },
      });
      await expect(liveRevision).resolves.toMatchObject({
        type: 'run.note.updated', runId, payload: { noteId, markdown: revisedMarkdown },
      });
      const mismatched = await app!.inject({
        method: 'PATCH',
        url: `/api/runs/missing-run/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must not be persisted.' },
      });
      expect(mismatched.statusCode).toBe(404);
      const mismatchedDelete = await app!.inject({
        method: 'DELETE',
        url: `/api/runs/missing-run/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
      });
      expect(mismatchedDelete.statusCode).toBe(404);
      const liveDeletion = waitForClientEvent(client, (event) => event.type === 'run.note.deleted');
      const deleted = await app!.inject({
        method: 'DELETE',
        url: `/api/runs/${runId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({
        note: { type: 'run.note.deleted', runId, payload: { noteId } },
      });
      await expect(liveDeletion).resolves.toMatchObject({
        type: 'run.note.deleted', runId, payload: { noteId },
      });
      const editDeleted = await app!.inject({
        method: 'PATCH',
        url: `/api/runs/${runId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must remain deleted.' },
      });
      expect(editDeleted.statusCode).toBe(404);
      expect(runner.calls).toHaveLength(runnerCallsBeforeNote);

      const blank = await app!.inject({
        method: 'POST',
        url: `/api/runs/${runId}/notes`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: ' \n\t ' },
      });
      expect(blank.statusCode).toBe(400);
      const missing = await app!.inject({
        method: 'POST',
        url: '/api/runs/missing-run/notes',
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must not be persisted.' },
      });
      expect(missing.statusCode).toBe(404);

      const persisted = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.type, 'run.note')));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        runId,
        sessionId: null,
        type: 'run.note',
        payload: { markdown, author: email },
      });
      const persistedRevisions = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.type, 'run.note.updated')));
      expect(persistedRevisions).toHaveLength(1);
      expect(persistedRevisions[0]).toMatchObject({ payload: { noteId, markdown: revisedMarkdown } });
      const persistedDeletions = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.runId, runId), eq(schema.events.type, 'run.note.deleted')));
      expect(persistedDeletions).toHaveLength(1);
      expect(persistedDeletions[0]).toMatchObject({ payload: { noteId } });

      const thread = await app!.inject({
        method: 'GET',
        url: `/api/runs/${runId}/thread`,
        headers: { host: 'localhost:7620', cookie },
      });
      expect(thread.statusCode).toBe(200);
      expect(thread.json()).toMatchObject({
        events: [
          expect.objectContaining({ type: 'run.note', runId, payload: { markdown, author: email } }),
          expect.objectContaining({ type: 'run.note.updated', runId, payload: { noteId, markdown: revisedMarkdown } }),
          expect.objectContaining({ type: 'run.note.deleted', runId, payload: { noteId } }),
        ],
      });
    } finally {
      await closeWebSocket(client);
      await runner.close();
    }

    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const reloadedThread = await app!.inject({
      method: 'GET',
      url: `/api/runs/${runId}/thread`,
      headers: { host: 'localhost:7620', cookie },
    });
    expect(reloadedThread.statusCode).toBe(200);
    expect(reloadedThread.json()).toMatchObject({
      events: [
        expect.objectContaining({ type: 'run.note', runId, payload: { markdown, author: email } }),
        expect.objectContaining({ type: 'run.note.updated', runId, payload: { noteId: expect.any(Number), markdown: '**Proceed** during the approved change window.' } }),
        expect.objectContaining({ type: 'run.note.deleted', runId, payload: { noteId: expect.any(Number) } }),
      ],
    });
  });

  it('persists notes on ended standalone sessions through REST, websocket, and reloaded history', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const email = 'session-note-operator@example.com';
    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Session Note Operator', email, password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

    const runner = await FakeRunner.connect(baseUrl);
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-session-note',
        name: 'Session Note Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });

    const sessionId = 'ended-standalone-session-note-st';
    const db = getDb();
    await db.insert(schema.sessions).values({
      id: sessionId,
      machineId: 'm-session-note',
      agent: 'claude',
      cwd: '/tmp/session-note-work',
      state: 'dead',
    });

    const client = await connectClientEvents(baseUrl, sessionId, cookie);
    const markdown = '**Handoff**: inspect the failed deployment before resuming.';
    try {
      const liveNote = waitForClientEvent(client, (event) => event.type === 'session.note');
      const runnerCallsBeforeNote = runner.calls.length;
      const created = await app!.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/notes`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: `  ${markdown}  ` },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        note: {
          seq: expect.any(Number),
          type: 'session.note',
          sessionId,
          payload: { markdown, author: email },
        },
      });
      await expect(liveNote).resolves.toMatchObject({
        type: 'session.note',
        sessionId,
        payload: { markdown, author: email },
      });
      const noteId = created.json().note.seq as number;
      const revisedMarkdown = '**Handoff corrected**: inspect the database migration first.';
      const liveRevision = waitForClientEvent(client, (event) => event.type === 'session.note.updated');
      const revised = await app!.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: `  ${revisedMarkdown}  ` },
      });
      expect(revised.statusCode).toBe(200);
      expect(revised.json()).toMatchObject({
        note: { type: 'session.note.updated', sessionId, payload: { noteId, markdown: revisedMarkdown } },
      });
      await expect(liveRevision).resolves.toMatchObject({
        type: 'session.note.updated', sessionId, payload: { noteId, markdown: revisedMarkdown },
      });
      const mismatched = await app!.inject({
        method: 'PATCH',
        url: `/api/sessions/missing-session/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must not be persisted.' },
      });
      expect(mismatched.statusCode).toBe(404);
      const mismatchedDelete = await app!.inject({
        method: 'DELETE',
        url: `/api/sessions/missing-session/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
      });
      expect(mismatchedDelete.statusCode).toBe(404);
      const liveDeletion = waitForClientEvent(client, (event) => event.type === 'session.note.deleted');
      const deleted = await app!.inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({
        note: { type: 'session.note.deleted', sessionId, payload: { noteId } },
      });
      await expect(liveDeletion).resolves.toMatchObject({
        type: 'session.note.deleted', sessionId, payload: { noteId },
      });
      const editDeleted = await app!.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}/notes/${noteId}`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must remain deleted.' },
      });
      expect(editDeleted.statusCode).toBe(404);
      expect(runner.calls).toHaveLength(runnerCallsBeforeNote);

      const blank = await app!.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/notes`,
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: ' \n\t ' },
      });
      expect(blank.statusCode).toBe(400);
      const missing = await app!.inject({
        method: 'POST',
        url: '/api/sessions/missing-session/notes',
        headers: { host: 'localhost:7620', cookie },
        payload: { markdown: 'Must not be persisted.' },
      });
      expect(missing.statusCode).toBe(404);

      const persisted = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.type, 'session.note')));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        sessionId,
        runId: null,
        type: 'session.note',
        payload: { markdown, author: email },
      });
      const persistedRevisions = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.type, 'session.note.updated')));
      expect(persistedRevisions).toHaveLength(1);
      expect(persistedRevisions[0]).toMatchObject({ payload: { noteId, markdown: revisedMarkdown } });
      const persistedDeletions = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.type, 'session.note.deleted')));
      expect(persistedDeletions).toHaveLength(1);
      expect(persistedDeletions[0]).toMatchObject({ payload: { noteId } });
    } finally {
      await closeWebSocket(client);
      await runner.close();
    }

    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const history = await app!.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/events`,
      headers: { host: 'localhost:7620', cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      events: [
        expect.objectContaining({ type: 'session.note', sessionId, payload: { markdown, author: email } }),
        expect.objectContaining({ type: 'session.note.updated', sessionId, payload: { noteId: expect.any(Number), markdown: '**Handoff corrected**: inspect the database migration first.' } }),
        expect.objectContaining({ type: 'session.note.deleted', sessionId, payload: { noteId: expect.any(Number) } }),
      ],
    });
  });

  it('archives and restores a terminal workflow run without changing linked history', async () => {
    const db = getDb();
    const defId = 'workflow-run-archive-def';
    const runId = 'workflow-run-archive-st';
    const activeRunId = 'workflow-run-archive-active';
    const sessionId = 'workflow-run-archive-session';
    const graph = {
      name: 'Archived release pipeline',
      nodes: [{ id: 'implement', type: 'agent', prompt: 'Ship the release' }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await db.insert(schema.workflowRuns).values([
      { id: runId, defId, status: 'done', context: { vars: { release: '1.0' }, outputs: {} }, endedAt: new Date() },
      { id: activeRunId, defId, status: 'running' },
    ]);
    await db.insert(schema.machines).values({ id: 'm-run-archive', name: 'Run Archive Runner' });
    await db.insert(schema.sessions).values({
      id: sessionId,
      machineId: 'm-run-archive',
      agent: 'claude',
      cwd: '/tmp/run-archive-work',
      state: 'dead',
      runId,
      nodeId: 'implement',
    });
    await db.insert(schema.nodeStates).values({
      runId,
      nodeId: 'implement',
      status: 'done',
      sessionId,
      output: { summary: 'release shipped' },
    });
    await db.insert(schema.events).values([
      { runId, type: 'run.status', payload: { status: 'done' } },
      { runId, sessionId, type: 'session.message', payload: { marker: 'retained run transcript' } },
    ]);
    await db.insert(schema.forgeRefs).values({
      id: 'workflow-run-archive-ref',
      forge: 'github',
      kind: 'pr',
      repo: 'example/release',
      number: 42,
      runId,
      nodeId: 'implement',
      sessionId,
      ciStatus: 'success',
    });

    const linkedBefore = {
      nodes: await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId)),
      sessions: await db.select().from(schema.sessions).where(eq(schema.sessions.runId, runId)),
      events: await db.select().from(schema.events).where(eq(schema.events.runId, runId)),
      forgeRefs: await db.select().from(schema.forgeRefs).where(eq(schema.forgeRefs.runId, runId)),
    };
    const beforeArchive = await app!.inject({ method: 'GET', url: '/api/runs' });
    expect(beforeArchive.json<{ runs: Array<{ id: string }> }>().runs.map((run) => run.id)).toEqual(
      expect.arrayContaining([runId, activeRunId]),
    );

    const archived = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      ok: true,
      run: { id: runId, archivedAt: expect.any(String) },
    });

    const [persisted] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(persisted?.archivedAt).toBeInstanceOf(Date);
    const defaultList = await app!.inject({ method: 'GET', url: '/api/runs' });
    const defaultRunIds = defaultList.json<{ runs: Array<{ id: string }> }>().runs.map((run) => run.id);
    expect(defaultRunIds).not.toContain(runId);
    expect(defaultRunIds).toContain(activeRunId);
    const archivedList = await app!.inject({ method: 'GET', url: '/api/runs?archived=true' });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json()).toMatchObject({
      runs: [{ id: runId, status: 'done', archivedAt: expect.any(String) }],
    });

    const detailWhileArchived = await app!.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(detailWhileArchived.statusCode).toBe(200);
    expect(detailWhileArchived.json()).toMatchObject({
      run: { id: runId, status: 'done', archivedAt: expect.any(String) },
      nodes: [{ runId, nodeId: 'implement', sessionId, output: { summary: 'release shipped' } }],
    });
    const threadWhileArchived = await app!.inject({ method: 'GET', url: `/api/runs/${runId}/thread` });
    expect(threadWhileArchived.statusCode).toBe(200);
    expect(threadWhileArchived.json()).toMatchObject({
      run: { id: runId, archivedAt: expect.any(String) },
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'session.message', payload: { marker: 'retained run transcript' } }),
      ]),
      forgeRefs: [expect.objectContaining({ id: 'workflow-run-archive-ref', runId, sessionId })],
    });

    const linkedAfterArchive = {
      nodes: await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId)),
      sessions: await db.select().from(schema.sessions).where(eq(schema.sessions.runId, runId)),
      events: await db.select().from(schema.events).where(eq(schema.events.runId, runId)),
      forgeRefs: await db.select().from(schema.forgeRefs).where(eq(schema.forgeRefs.runId, runId)),
    };
    expect(linkedAfterArchive).toEqual(linkedBefore);

    const active = await app!.inject({ method: 'POST', url: `/api/runs/${activeRunId}/archive` });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ error: expect.stringContaining('still active') });
    const [activePersisted] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, activeRunId));
    expect(activePersisted?.archivedAt).toBeNull();

    const restored = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ok: true, run: { id: runId, archivedAt: null } });
    const restoredList = await app!.inject({ method: 'GET', url: '/api/runs' });
    expect(restoredList.json<{ runs: Array<{ id: string }> }>().runs.map((run) => run.id)).toContain(runId);
    const emptyArchive = await app!.inject({ method: 'GET', url: '/api/runs?archived=true' });
    expect(emptyArchive.json()).toEqual({ runs: [] });
  });

  it('starts a separate run from a terminal run with the same definition, project, and inputs', async () => {
    const db = getDb();
    const defId = 'workflow-rerun-def';
    const projectId = 'workflow-rerun-project';
    const sourceRunId = 'workflow-rerun-source';
    const activeRunId = 'workflow-rerun-active';
    const graph = {
      name: 'Repeatable release approval',
      vars: { release: 'default', environment: 'test' },
      nodes: [{ id: 'approve', type: 'gate', approvers: ['release-owner'] }],
      edges: [],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph, projectId });
    await db.insert(schema.workflowRuns).values([
      {
        id: sourceRunId,
        defId,
        projectId,
        status: 'done',
        context: {
          vars: { release: '2.4.0', environment: 'production' },
          outputs: { approve: 'approved in the source run' },
        },
        endedAt: new Date('2026-07-14T08:00:00Z'),
      },
      {
        id: activeRunId,
        defId,
        projectId,
        status: 'paused',
        context: { vars: { release: 'next', environment: 'staging' }, outputs: {} },
      },
    ]);
    await db.insert(schema.nodeStates).values([
      { runId: sourceRunId, nodeId: 'approve', status: 'done', output: { summary: 'source evidence' } },
      { runId: activeRunId, nodeId: 'approve', status: 'pending' },
    ]);
    const [sourceBefore] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, sourceRunId));
    const sourceNodesBefore = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, sourceRunId));

    const response = await app!.inject({ method: 'POST', url: `/api/runs/${sourceRunId}/rerun` });
    expect(response.statusCode).toBe(201);
    const { runId: newRunId } = response.json<{ runId: string }>();
    expect(newRunId).not.toBe(sourceRunId);

    await vi.waitFor(async () => {
      const [newRun] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, newRunId));
      expect(newRun).toMatchObject({
        id: newRunId,
        defId,
        projectId,
        status: 'waiting_human',
        context: {
          vars: { release: '2.4.0', environment: 'production' },
          outputs: {},
        },
      });
      const newNodes = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, newRunId));
      expect(newNodes).toEqual([
        expect.objectContaining({ runId: newRunId, nodeId: 'approve', status: 'waiting_human' }),
      ]);
    });

    const [sourceAfter] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, sourceRunId));
    const sourceNodesAfter = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, sourceRunId));
    expect(sourceAfter).toEqual(sourceBefore);
    expect(sourceNodesAfter).toEqual(sourceNodesBefore);

    const active = await app!.inject({ method: 'POST', url: `/api/runs/${activeRunId}/rerun` });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toEqual({ error: 'run is still active: paused' });
    const missing = await app!.inject({ method: 'POST', url: '/api/runs/missing/rerun' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'run not found: missing' });
    const allRuns = await db.select().from(schema.workflowRuns);
    expect(allRuns).toHaveLength(3);
  });

  it('atomically retries failed workflow nodes in place and reschedules the engine once', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-retry-1' }),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-run-retry',
        name: 'Run Retry Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });

    const db = getDb();
    const defId = 'workflow-run-retry-def';
    const runId = 'workflow-run-retry-st';
    const endedAt = new Date('2026-07-11T06:00:00Z');
    const graph = {
      name: 'Retry release pipeline',
      nodes: [
        { id: 'prepare', type: 'agent', prompt: 'Prepare the release', machine: { labels: ['dev'] }, cwd: '/tmp/run-retry' },
        { id: 'deploy', type: 'agent', prompt: 'Deploy {{outputs.prepare}}', machine: { labels: ['dev'] }, cwd: '/tmp/run-retry' },
        { id: 'announce', type: 'agent', prompt: 'Announce the release', machine: { labels: ['dev'] }, cwd: '/tmp/run-retry' },
      ],
      edges: [['prepare', 'deploy']],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });
    await db.insert(schema.workflowRuns).values({
      id: runId,
      defId,
      status: 'failed',
      context: {
        vars: { release: '1.0' },
        outputs: { prepare: 'artifact ready', deploy: 'stale failed output', announce: 'intentionally skipped' },
      },
      endedAt,
    });
    await db.insert(schema.sessions).values([
      {
        id: 'run-retry-prepare-session',
        machineId: 'm-run-retry',
        agent: 'claude',
        cwd: '/tmp/run-retry',
        state: 'dead',
        runId,
        nodeId: 'prepare',
      },
      {
        id: 'run-retry-failed-session',
        machineId: 'm-run-retry',
        agent: 'claude',
        cwd: '/tmp/run-retry',
        state: 'dead',
        runId,
        nodeId: 'deploy',
      },
    ]);
    await db.insert(schema.nodeStates).values([
      {
        runId,
        nodeId: 'prepare',
        status: 'done',
        sessionId: 'run-retry-prepare-session',
        output: { summary: 'artifact ready' },
        updatedAt: new Date('2026-07-11T05:55:00Z'),
      },
      {
        runId,
        nodeId: 'deploy',
        status: 'failed',
        sessionId: 'run-retry-failed-session',
        output: { error: 'registry unavailable', summary: 'stale failed output' },
        updatedAt: new Date('2026-07-11T06:00:00Z'),
      },
      {
        runId,
        nodeId: 'announce',
        status: 'skipped',
        output: { reason: 'not required for this release' },
        updatedAt: new Date('2026-07-11T05:56:00Z'),
      },
    ]);
    await db.insert(schema.events).values({
      runId,
      type: 'run.finished',
      payload: { status: 'failed', marker: 'retained timeline' },
    });
    const retainedBefore = (await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId)))
      .filter((node) => node.nodeId !== 'deploy')
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    const responses = await Promise.all([
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/retry` }),
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/retry` }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const accepted = responses.find((response) => response.statusCode === 200)!;
    expect(accepted.json()).toEqual({
      ok: true,
      run: { id: runId, status: 'running', endedAt: null },
      retriedNodeIds: ['deploy'],
    });

    await vi.waitFor(async () => {
      const [retried] = await db
        .select()
        .from(schema.nodeStates)
        .where(eq(schema.nodeStates.nodeId, 'deploy'));
      expect(retried).toMatchObject({ status: 'running', output: null });
      expect(retried?.sessionId).not.toBe('run-retry-failed-session');
      expect(runner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(1);
    });

    const [persistedRun] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(persistedRun).toMatchObject({
      status: 'running',
      endedAt: null,
      context: {
        vars: { release: '1.0' },
        outputs: { prepare: 'artifact ready', announce: 'intentionally skipped' },
      },
    });
    const retainedAfter = (await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId)))
      .filter((node) => node.nodeId !== 'deploy')
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    expect(retainedAfter).toEqual(retainedBefore);

    const retryEvents = (await db.select().from(schema.events).where(eq(schema.events.runId, runId)))
      .filter((event) => event.type === 'run.retried');
    expect(retryEvents).toEqual([
      expect.objectContaining({
        runId,
        payload: { by: 'ui', retriedNodeIds: ['deploy'] },
      }),
    ]);
    const thread = await app!.inject({ method: 'GET', url: `/api/runs/${runId}/thread` });
    expect(thread.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'run.finished', payload: { status: 'failed', marker: 'retained timeline' } }),
        expect.objectContaining({ type: 'run.retried', payload: { by: 'ui', retriedNodeIds: ['deploy'] } }),
      ]),
    });
  });

  it('keeps downstream workflow work paused across restart and starts it once after resume', async () => {
    const firstRunner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-pause-first' }),
    });
    runners.push(firstRunner);
    const machineInfo = {
      id: 'm-run-progression',
      name: 'Run Progression Runner',
      labels: ['pause-st'],
      resources: [],
      runnerVersion: 'st',
      startedAt: Date.now(),
    };
    await firstRunner.callServer('machine.register', { info: machineInfo });

    const db = getDb();
    const defId = 'workflow-run-progression-def';
    const graph = {
      name: 'Pause and resume pipeline',
      nodes: [
        { id: 'prepare', type: 'agent', prompt: 'Prepare release', machine: { labels: ['pause-st'] }, cwd: '/tmp/run-progression' },
        { id: 'publish', type: 'agent', prompt: 'Publish release', machine: { labels: ['pause-st'] }, cwd: '/tmp/run-progression' },
      ],
      edges: [['prepare', 'publish']],
    };
    await db.insert(schema.workflowDefs).values({ id: defId, name: graph.name, graph });

    const started = await app!.inject({ method: 'POST', url: `/api/workflows/${defId}/runs`, payload: { vars: {} } });
    expect(started.statusCode).toBe(201);
    const { runId } = started.json<{ runId: string }>();
    await vi.waitFor(() => {
      expect(firstRunner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(1);
    });
    expect(firstRunner.calls.find((call) => call.method === 'session.spawn')).toMatchObject({
      params: { runId, nodeId: 'prepare', prompt: 'Prepare release' },
    });

    const pauseResponses = await Promise.all([
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/pause` }),
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/pause` }),
    ]);
    expect(pauseResponses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const [paused] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(paused?.status).toBe('paused');

    const [prepare] = await db
      .select()
      .from(schema.nodeStates)
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, 'prepare')));
    expect(prepare).toMatchObject({ status: 'running' });
    await db
      .update(schema.nodeStates)
      .set({ status: 'done', output: { summary: 'release ready' }, updatedAt: new Date() })
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, 'prepare')));
    if (prepare?.sessionId) {
      await db.update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, prepare.sessionId));
    }
    await db.insert(schema.events).values({
      runId,
      type: 'run.node.state',
      payload: { nodeId: 'prepare', status: 'done', sessionId: prepare?.sessionId },
    });
    scheduleTick(runId);
    await serializeRunProgression(runId, async () => {});

    const [suppressed] = await db
      .select()
      .from(schema.nodeStates)
      .where(and(eq(schema.nodeStates.runId, runId), eq(schema.nodeStates.nodeId, 'publish')));
    expect(suppressed?.status).toBe('pending');
    expect(firstRunner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(1);

    await firstRunner.close();
    await app!.close();
    app = null;
    await startApp();

    const secondRunner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-pause-second' }),
    });
    runners.push(secondRunner);
    await secondRunner.callServer('machine.register', { info: { ...machineInfo, startedAt: Date.now() } });
    await resumeActiveRuns();
    await serializeRunProgression(runId, async () => {});

    const persisted = await app!.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toMatchObject({ run: { id: runId, status: 'paused' } });
    expect(secondRunner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(0);

    const resumeResponses = await Promise.all([
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/resume` }),
      app!.inject({ method: 'POST', url: `/api/runs/${runId}/resume` }),
    ]);
    expect(resumeResponses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await serializeRunProgression(runId, async () => {});

    expect(secondRunner.calls.filter((call) => call.method === 'session.spawn')).toHaveLength(1);
    expect(secondRunner.calls.find((call) => call.method === 'session.spawn')).toMatchObject({
      params: { runId, nodeId: 'publish', prompt: 'Publish release' },
    });
    const states = await db.select().from(schema.nodeStates).where(eq(schema.nodeStates.runId, runId));
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'prepare', status: 'done' }),
      expect.objectContaining({ nodeId: 'publish', status: 'running' }),
    ]));
    const progressionEvents = (await db.select().from(schema.events).where(eq(schema.events.runId, runId)))
      .filter((event) => event.type === 'run.status');
    expect(progressionEvents.map((event) => event.payload)).toEqual([
      { status: 'paused', by: 'ui' },
      { status: 'running', by: 'ui' },
    ]);

    const cancellableRunId = 'workflow-run-paused-cancellable';
    await db.insert(schema.workflowRuns).values({ id: cancellableRunId, defId, status: 'paused' });
    await db.insert(schema.nodeStates).values({ runId: cancellableRunId, nodeId: 'prepare', status: 'pending' });
    const cancelled = await app!.inject({ method: 'POST', url: `/api/runs/${cancellableRunId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    const [cancelledRun] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, cancellableRunId));
    expect(cancelledRun?.status).toBe('cancelled');
  });

  it('binds allocated NVIDIA GPUs to a container while keeping the runner exclusively reserved', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.provision': () => ({
        ok: true,
        cwd: '/data/co/wt/nvidia-session',
        branch: 'co/nvidia-session',
        basePath: '/data/co/base/nvidia-project',
      }),
      'container.run': () => ({ ok: true, containerId: 'nvidia-container-1' }),
      'container.exec': () => ({ exitCode: 0, stdout: '', stderr: '' }),
      'session.spawn': () => ({ ok: true, nativeSessionId: 'native-nvidia-1' }),
    });
    runners.push(runner);

    await expect(
      runner.callServer('machine.register', {
        info: {
          id: 'm-nvidia',
          name: 'NVIDIA Runner',
          labels: ['gpu'],
          resources: [
            { kind: 'nvidia-gpu', index: 0 },
            { kind: 'nvidia-gpu', index: 1 },
          ],
          runnerVersion: 'st',
          startedAt: Date.now(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    const project = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'NVIDIA Container ST',
        forge: 'github',
        repo: 'example/nvidia-container',
        baseImage: 'nvidia/cuda:latest',
        accel: { kind: 'nvidia-gpu' },
      },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };

    const spawn = await app!.inject({
      method: 'POST',
      url: '/api/container-sessions',
      payload: { projectId, prompt: 'run on both allocated GPUs', agent: 'claude' },
    });
    expect(spawn.statusCode).toBe(200);
    const { sessionId } = spawn.json() as { sessionId: string };

    expect(runner.calls.find((call) => call.method === 'container.run')).toMatchObject({
      params: {
        image: 'nvidia/cuda:latest',
        devices: [],
        gpus: 'device=0,1',
      },
    });

    const queued = await app!.inject({
      method: 'POST',
      url: '/api/container-sessions',
      payload: { projectId, prompt: 'wait for the reserved runner', agent: 'claude' },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, taskId: expect.any(String) });
    expect(runner.calls.filter((call) => call.method === 'container.run')).toHaveLength(1);

    const reservations = await getDb()
      .select({
        machineId: schema.resourceReservations.machineId,
        sessionId: schema.resourceReservations.sessionId,
        kind: schema.resourceReservations.kind,
        status: schema.resourceReservations.status,
      })
      .from(schema.resourceReservations)
      .where(eq(schema.resourceReservations.sessionId, sessionId));
    expect(reservations).toEqual([
      { machineId: 'm-nvidia', sessionId, kind: 'nvidia-gpu', status: 'active' },
    ]);
  });

  it('resumes a dead manual session on its original runner and keeps its timeline for subsequent messages', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.resume': () => ({ ok: true }),
      'session.send': () => ({ ok: true }),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-resume',
        name: 'Resume Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });

    const sessionId = 'session-resume-st';
    await getDb().insert(schema.sessions).values({
      id: sessionId,
      machineId: 'm-resume',
      agent: 'claude',
      model: 'claude-sonnet',
      cwd: '/tmp/resume-work',
      state: 'dead',
      nativeSessionId: 'claude-native-resume',
    });
    const [before] = await getDb()
      .insert(schema.events)
      .values({ sessionId, type: 'session.message', payload: { marker: 'before-runner-restart' } })
      .returning({ seq: schema.events.seq });

    const resumed = await app!.inject({ method: 'POST', url: `/api/sessions/${sessionId}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ ok: true, sessionId });
    expect(runner.calls.find((call) => call.method === 'session.resume')).toMatchObject({
      params: {
        sessionId,
        agent: 'claude',
        cwd: '/tmp/resume-work',
        nativeSessionId: 'claude-native-resume',
      },
    });
    const [claimed] = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(claimed?.state).toBe('starting');

    await expect(
      runner.callServer('session.state', {
        sessionId,
        state: 'idle',
        nativeSessionId: 'claude-native-resume',
      }),
    ).resolves.toEqual({ ok: true });
    const sent = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/send`,
      payload: { text: 'continue with the earlier context' },
    });
    expect(sent.statusCode).toBe(200);
    expect(runner.calls.find((call) => call.method === 'session.send')).toMatchObject({
      params: { sessionId, text: 'continue with the earlier context' },
    });

    const timeline = await app!.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const events = timeline.json<{ events: Array<{ seq: number; type: string; payload: unknown }> }>().events;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: before!.seq, type: 'session.message', payload: { marker: 'before-runner-restart' } }),
        expect.objectContaining({ type: 'session.state', payload: expect.objectContaining({ state: 'idle' }) }),
      ]),
    );
  });

  it('forks a saved host session through REST, persistence, and runner while keeping transcripts independent', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.fork': () => ({ ok: true, nativeSessionId: 'claude-native-fork' }),
      'session.send': () => ({ ok: true }),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-fork',
        name: 'Fork Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });

    const sourceSessionId = 'session-fork-source';
    await getDb().insert(schema.sessions).values({
      id: sourceSessionId,
      machineId: 'm-fork',
      agent: 'claude',
      model: 'claude-sonnet',
      cwd: '/tmp/fork-work',
      title: 'Saved conversation',
      state: 'idle',
      nativeSessionId: 'claude-native-source',
    });
    const sourceTranscript = [
      {
        id: 'source-user-message',
        time: 1,
        role: 'user',
        claudeUuid: 'claude-message-user',
        ev: { t: 'text', text: 'keep this original question' },
      },
      {
        id: 'source-agent-message',
        time: 2,
        role: 'agent',
        claudeUuid: 'claude-message-agent',
        ev: { t: 'text', text: 'keep this original answer' },
      },
    ];
    await getDb().insert(schema.events).values([
      { sessionId: sourceSessionId, type: 'session.created', payload: { marker: 'source-created' } },
      ...sourceTranscript.map((payload) => ({ sessionId: sourceSessionId, type: 'session.message', payload })),
    ]);

    const forked = await app!.inject({ method: 'POST', url: `/api/sessions/${sourceSessionId}/fork` });
    expect(forked.statusCode).toBe(200);
    const { sessionId: forkSessionId } = forked.json() as { ok: true; sessionId: string };
    expect(forkSessionId).not.toBe(sourceSessionId);
    expect(runner.calls.find((call) => call.method === 'session.fork')).toMatchObject({
      params: {
        sourceSessionId,
        sessionId: forkSessionId,
        agent: 'claude',
        cwd: '/tmp/fork-work',
        nativeSessionId: 'claude-native-source',
      },
    });

    const [source] = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sourceSessionId));
    const [target] = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, forkSessionId));
    expect(source).toMatchObject({
      id: sourceSessionId,
      state: 'idle',
      nativeSessionId: 'claude-native-source',
      title: 'Saved conversation',
    });
    expect(target).toMatchObject({
      id: forkSessionId,
      machineId: 'm-fork',
      state: 'starting',
      nativeSessionId: 'claude-native-fork',
      title: 'Saved conversation (fork)',
      runId: null,
      containerId: null,
    });

    const targetBeforeSend = await app!.inject({ method: 'GET', url: `/api/sessions/${forkSessionId}/events` });
    const copiedMessages = targetBeforeSend
      .json<{ events: Array<{ type: string; payload: unknown }> }>()
      .events.filter((event) => event.type === 'session.message');
    expect(copiedMessages.map((event) => event.payload)).toEqual(sourceTranscript);

    const sent = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${forkSessionId}/send`,
      payload: { text: 'continue only on the fork' },
    });
    expect(sent.statusCode).toBe(200);
    expect(runner.calls.find((call) => call.method === 'session.send')).toMatchObject({
      params: { sessionId: forkSessionId, text: 'continue only on the fork' },
    });
    await runner.callServer('session.event', {
      sessionId: forkSessionId,
      envelope: {
        id: 'fork-user-message',
        time: 3,
        role: 'user',
        ev: { t: 'text', text: 'continue only on the fork' },
      },
    });

    const sourceAfter = await app!.inject({ method: 'GET', url: `/api/sessions/${sourceSessionId}/events` });
    const targetAfter = await app!.inject({ method: 'GET', url: `/api/sessions/${forkSessionId}/events` });
    expect(
      sourceAfter.json<{ events: Array<{ type: string; payload: unknown }> }>().events
        .filter((event) => event.type === 'session.message')
        .map((event) => event.payload),
    ).toEqual(sourceTranscript);
    expect(
      targetAfter.json<{ events: Array<{ type: string; payload: { ev?: { text?: string } } }> }>().events
        .filter((event) => event.type === 'session.message')
        .map((event) => event.payload.ev?.text),
    ).toEqual(['keep this original question', 'keep this original answer', 'continue only on the fork']);
  });

  it('rejects ineligible fork requests without runner calls or partial target rows', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.fork': () => ({ ok: true, nativeSessionId: 'should-not-be-created' }),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-fork-guard',
        name: 'Fork Guard Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });
    await getDb().insert(schema.machines).values({ id: 'm-fork-offline', name: 'Offline Fork Runner' });
    await getDb().insert(schema.sessions).values([
      {
        id: 'fork-busy', machineId: 'm-fork-guard', agent: 'claude', cwd: '/tmp/busy',
        state: 'thinking', nativeSessionId: 'native-busy',
      },
      {
        id: 'fork-workflow', machineId: 'm-fork-guard', agent: 'claude', cwd: '/tmp/workflow',
        state: 'idle', nativeSessionId: 'native-workflow', runId: 'run-1',
      },
      {
        id: 'fork-container', machineId: 'm-fork-guard', agent: 'claude', cwd: '/tmp/container',
        state: 'dead', nativeSessionId: 'native-container', containerId: 'container-1',
      },
      {
        id: 'fork-missing-native', machineId: 'm-fork-guard', agent: 'codex', cwd: '/tmp/missing',
        state: 'idle', nativeSessionId: null,
      },
      {
        id: 'fork-offline', machineId: 'm-fork-offline', agent: 'codex', cwd: '/tmp/offline',
        state: 'dead', nativeSessionId: 'thread-offline',
      },
    ]);

    const sourceIds = ['fork-busy', 'fork-workflow', 'fork-container', 'fork-missing-native', 'fork-offline'];
    for (const sourceId of sourceIds) {
      const response = await app!.inject({ method: 'POST', url: `/api/sessions/${sourceId}/fork` });
      expect(response.statusCode).toBe(409);
    }

    expect(runner.calls.filter((call) => call.method === 'session.fork')).toHaveLength(0);
    const sessions = await getDb().select({ id: schema.sessions.id }).from(schema.sessions);
    expect(sessions.map((row) => row.id).sort()).toEqual([...sourceIds].sort());
    const targetEvents = await getDb().select().from(schema.events);
    expect(targetEvents).toHaveLength(0);
  });

  it('serializes concurrent resume requests, rejects ineligible sessions, and rolls back runner failures', async () => {
    let releaseConcurrent!: () => void;
    const concurrentGate = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const runner = await FakeRunner.connect(baseUrl, {
      'session.resume': async (params) => {
        const { sessionId } = params as { sessionId: string };
        if (sessionId === 'session-resume-concurrent') {
          await concurrentGate;
          return { ok: true };
        }
        return { ok: false, error: 'native context unavailable' };
      },
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: {
        id: 'm-resume-guard',
        name: 'Resume Guard Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });
    await getDb().insert(schema.sessions).values([
      {
        id: 'session-resume-concurrent',
        machineId: 'm-resume-guard',
        agent: 'codex',
        cwd: '/tmp/concurrent',
        state: 'dead',
        nativeSessionId: 'thread-concurrent',
      },
      {
        id: 'session-resume-failure',
        machineId: 'm-resume-guard',
        agent: 'codex',
        cwd: '/tmp/failure',
        state: 'dead',
        nativeSessionId: 'thread-failure',
      },
      {
        id: 'session-resume-workflow',
        machineId: 'm-resume-guard',
        agent: 'claude',
        cwd: '/tmp/workflow',
        state: 'dead',
        nativeSessionId: 'native-workflow',
        runId: 'run-owned-session',
      },
    ]);

    const first = app!.inject({ method: 'POST', url: '/api/sessions/session-resume-concurrent/resume' });
    await vi.waitFor(() =>
      expect(runner.calls).toContainEqual(
        expect.objectContaining({ method: 'session.resume', params: expect.objectContaining({ sessionId: 'session-resume-concurrent' }) }),
      ),
    );
    const concurrent = await app!.inject({ method: 'POST', url: '/api/sessions/session-resume-concurrent/resume' });
    expect(concurrent.statusCode).toBe(409);
    releaseConcurrent();
    expect((await first).statusCode).toBe(200);

    const ineligible = await app!.inject({ method: 'POST', url: '/api/sessions/session-resume-workflow/resume' });
    expect(ineligible.statusCode).toBe(409);
    const [workflow] = await getDb()
      .select({ state: schema.sessions.state })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, 'session-resume-workflow'));
    expect(workflow?.state).toBe('dead');

    const failed = await app!.inject({ method: 'POST', url: '/api/sessions/session-resume-failure/resume' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: 'native context unavailable' });
    const [rolledBack] = await getDb()
      .select({ state: schema.sessions.state })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, 'session-resume-failure'));
    expect(rolledBack?.state).toBe('dead');
  });

  it('forwards Codex interactive answers across REST and runner/client websockets', async () => {
    const runner = await FakeRunner.connect(baseUrl, {
      'session.spawn': () => ({ ok: true, nativeSessionId: 'codex-thread-1' }),
      'approval.decide': () => ({ ok: true }),
    });
    runners.push(runner);

    await runner.callServer('machine.register', {
      info: {
        id: 'm-codex-input',
        name: 'Codex Input Runner',
        labels: ['dev'],
        resources: [],
        runnerVersion: 'st',
        startedAt: Date.now(),
      },
    });
    const spawn = await app!.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { machineId: 'm-codex-input', cwd: '/tmp/codex-input', agent: 'codex' },
    });
    expect(spawn.statusCode).toBe(200);
    const { sessionId } = spawn.json() as { sessionId: string };
    const client = await connectClientEvents(baseUrl, sessionId);

    try {
      const waitingEvent = waitForClientEvent(
        client,
        (event) => event.type === 'session.state' && (event.payload as { state?: string }).state === 'waiting_input',
      );
      await expect(runner.callServer('session.state', { sessionId, state: 'waiting_input' })).resolves.toEqual({ ok: true });
      await expect(waitingEvent).resolves.toMatchObject({
        type: 'session.state',
        sessionId,
        payload: { state: 'waiting_input' },
      });

      const questions = [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which area should be changed?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'Runner', description: 'Only update the runner package.' }],
        },
      ];
      const requestedEvent = waitForClientEvent(client, (event) => event.type === 'approval.requested');
      await expect(
        runner.callServer('approval.request', {
          request: {
            id: 'codex-input-1',
            kind: 'tool',
            sessionId,
            title: 'Scope',
            payload: {
              backend: 'codex',
              method: 'item/tool/requestUserInput',
              params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'item-1', questions, autoResolutionMs: null },
            },
            requestedAt: Date.now(),
          },
        }),
      ).resolves.toEqual({ ok: true });
      await expect(requestedEvent).resolves.toMatchObject({
        type: 'approval.requested',
        sessionId,
        payload: { id: 'codex-input-1', payload: { method: 'item/tool/requestUserInput', params: { questions } } },
      });

      const answers = { scope: { answers: ['Runner'] } };
      const decidedEvent = waitForClientEvent(client, (event) => event.type === 'approval.decided');
      const response = await app!.inject({
        method: 'POST',
        url: '/api/approvals/codex-input-1/decide',
        payload: { decision: { behavior: 'allow', updatedInput: { answers } }, decidedBy: 'st' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, status: 'approved' });
      expect(runner.calls.find((call) => call.method === 'approval.decide')).toMatchObject({
        params: {
          approvalId: 'codex-input-1',
          sessionId,
          decision: { behavior: 'allow', updatedInput: { answers } },
        },
      });
      const persisted = await app!.inject({ method: 'GET', url: '/api/approvals?status=approved' });
      expect(persisted.statusCode).toBe(200);
      expect(persisted.json()).toMatchObject({
        approvals: [{ id: 'codex-input-1', decision: { behavior: 'allow', updatedInput: { answers } } }],
      });
      await expect(decidedEvent).resolves.toMatchObject({
        type: 'approval.decided',
        sessionId,
        payload: { approvalId: 'codex-input-1', status: 'approved' },
      });
    } finally {
      await closeWebSocket(client);
    }
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

  it('deletes a non-empty workspace folder through the authenticated runner RPC boundary', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Folder Operator', email: 'folder-delete@example.com', password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-delete-st-'));
    await mkdir(join(root, 'reports', 'archive'), { recursive: true });
    await writeFile(join(root, 'reports', 'archive', 'result.txt'), 'delete through runner RPC');

    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.delete': (params) => {
        expect(params).toEqual({ root, path: 'reports/archive' });
        return deleteHostWorkspaceFile(root, 'reports/archive');
      },
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-folder-delete', name: 'Folder Delete Runner', labels: ['dev'], resources: [], runnerVersion: 'st', startedAt: Date.now() },
    });
    await getDb().insert(schema.sessions).values({
      id: 'session-folder-delete-st', machineId: 'm-folder-delete', agent: 'claude', cwd: root, state: 'idle',
    });

    const deletion = await app!.inject({
      method: 'DELETE',
      url: '/api/sessions/session-folder-delete-st/files?path=reports%2Farchive',
      headers: { host: 'localhost:7620', cookie },
    });

    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toEqual({ ok: true, path: 'reports/archive' });
    await expect(access(join(root, 'reports', 'archive'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists workspace executable state through authenticated REST and runner RPC', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Script Operator', email: 'script-mode@example.com', password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const root = await mkdtemp(join(tmpdir(), 'co-workspace-chmod-st-'));
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho ready\n', { mode: 0o600 });

    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.list': (params) => {
        expect(params).toEqual({ root, path: '' });
        return listHostWorkspaceDirectory(root, '');
      },
      'workspace.chmod': (params) => {
        expect(params).toEqual({ root, path: 'run.sh', executable: true });
        return chmodHostWorkspaceFile(root, 'run.sh', true);
      },
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-script-mode', name: 'Script Mode Runner', labels: ['dev'], resources: [], runnerVersion: 'st', startedAt: Date.now() },
    });
    await getDb().insert(schema.sessions).values({
      id: 'session-script-mode-st', machineId: 'm-script-mode', agent: 'claude', cwd: root, state: 'idle',
    });

    const unauthorized = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-script-mode-st/files/executable?path=run.sh',
      headers: { host: 'localhost:7620', 'content-type': 'application/json' },
      payload: { executable: true },
    });
    expect(unauthorized.statusCode).toBe(401);

    const before = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-script-mode-st/files/list?path=',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      entries: [{ name: 'run.sh', type: 'file', executable: false }],
    });

    const changed = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-script-mode-st/files/executable?path=run.sh',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/json' },
      payload: { executable: true },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true, path: 'run.sh', executable: true });

    const refreshed = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-script-mode-st/files/list?path=',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      entries: [{ name: 'run.sh', type: 'file', executable: true }],
    });
  });

  it('downloads exact binary Git patch bytes through the runner RPC as an attachment', async () => {
    const source = await mkdtemp(join(tmpdir(), 'co-patch-st-source-'));
    await run('git', ['init', '-q'], { cwd: source });
    await writeFile(join(source, 'tracked.txt'), 'before\n');
    await writeFile(join(source, 'image.bin'), Buffer.alloc(2_048, 0));
    await run('git', ['add', '.'], { cwd: source });
    await run('git', [
      '-c', 'user.name=Patch ST', '-c', 'user.email=patch-st@example.com', 'commit', '-qm', 'base',
    ], { cwd: source });
    const clean = await mkdtemp(join(tmpdir(), 'co-patch-st-clean-'));
    await run('git', ['clone', '-q', source, clean]);
    await writeFile(join(source, 'tracked.txt'), 'after\n');
    await writeFile(join(source, 'image.bin'), Buffer.alloc(2_048, 255));
    const expected = Buffer.from((await run('git', ['diff', '--binary', 'HEAD'], {
      cwd: source,
      encoding: 'buffer',
    })).stdout);

    const runnerMethod = createRunnerMethodHandler({ conn: null });
    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.patch': (params) => runnerMethod('workspace.patch', params),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-patch', name: 'Patch Runner', labels: ['dev'], resources: [], runnerVersion: 'st', startedAt: Date.now() },
    });
    const nonGit = await mkdtemp(join(tmpdir(), 'co-patch-st-non-git-'));
    await getDb().insert(schema.sessions).values([
      {
        id: 'session-patch-st', machineId: 'm-patch', agent: 'claude', cwd: source,
        title: 'Fix binary / 修复', state: 'idle',
      },
      { id: 'session-patch-empty-st', machineId: 'm-patch', agent: 'claude', cwd: clean, state: 'idle' },
      { id: 'session-patch-non-git-st', machineId: 'm-patch', agent: 'claude', cwd: nonGit, state: 'idle' },
    ]);

    const downloaded = await app!.inject({ method: 'GET', url: '/api/sessions/session-patch-st/patch' });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('text/x-diff; charset=utf-8');
    expect(downloaded.headers['content-length']).toBe(String(expected.length));
    expect(downloaded.headers['content-disposition']).toBe(
      "attachment; filename=\"Fix binary _ __.patch\"; filename*=UTF-8''Fix%20binary%20_%20%E4%BF%AE%E5%A4%8D.patch",
    );
    expect(downloaded.rawPayload).toEqual(expected);
    const downloadedPatch = join(clean, 'downloaded.patch');
    await writeFile(downloadedPatch, downloaded.rawPayload);
    await expect(run('git', ['apply', '--check', downloadedPatch], { cwd: clean })).resolves.toBeDefined();
    expect(runner.calls).toContainEqual({
      method: 'workspace.patch',
      params: { root: source },
    });

    const empty = await app!.inject({ method: 'GET', url: '/api/sessions/session-patch-empty-st/patch' });
    expect(empty.statusCode).toBe(409);
    expect(empty.json()).toEqual({ error: '工作目录没有已跟踪的变更' });

    const invalid = await app!.inject({ method: 'GET', url: '/api/sessions/session-patch-non-git-st/patch' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('not a git repository');
  });

  it('discards one tracked file through REST and runner RPC without touching other changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'co-restore-st-'));
    await run('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'selected.txt'), 'selected before\n');
    await writeFile(join(root, 'other.txt'), 'other before\n');
    await run('git', ['add', '.'], { cwd: root });
    await run('git', [
      '-c', 'user.name=Restore ST', '-c', 'user.email=restore-st@example.com', 'commit', '-qm', 'base',
    ], { cwd: root });
    await writeFile(join(root, 'selected.txt'), 'selected changed\n');
    await writeFile(join(root, 'other.txt'), 'other changed\n');
    await writeFile(join(root, 'untracked.txt'), 'keep untracked\n');

    const runnerMethod = createRunnerMethodHandler({ conn: null });
    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.restore': (params) => runnerMethod('workspace.restore', params),
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-restore', name: 'Restore Runner', labels: ['dev'], resources: [], runnerVersion: 'st', startedAt: Date.now() },
    });
    await getDb().insert(schema.sessions).values({
      id: 'session-restore-st', machineId: 'm-restore', agent: 'claude', cwd: root, state: 'idle',
    });

    const restored = await app!.inject({
      method: 'POST', url: '/api/sessions/session-restore-st/files/restore?path=selected.txt',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ok: true, path: 'selected.txt' });
    expect(runner.calls).toContainEqual({
      method: 'workspace.restore', params: { root, path: 'selected.txt' },
    });
    await expect(readFile(join(root, 'selected.txt'), 'utf8')).resolves.toBe('selected before\n');
    await expect(readFile(join(root, 'other.txt'), 'utf8')).resolves.toBe('other changed\n');
    expect((await run('git', ['diff', '--name-only', 'HEAD'], { cwd: root })).stdout).toBe('other.txt\n');

    const untracked = await app!.inject({
      method: 'POST', url: '/api/sessions/session-restore-st/files/restore?path=untracked.txt',
    });
    expect(untracked.statusCode).toBe(400);
    expect(untracked.json().error).toContain('not a tracked file');
    await expect(readFile(join(root, 'untracked.txt'), 'utf8')).resolves.toBe('keep untracked\n');

    await writeFile(join(root, 'selected.txt'), 'must survive offline request\n');
    await getDb().insert(schema.sessions).values({
      id: 'session-restore-offline-st', machineId: 'm-restore-offline', agent: 'claude', cwd: root, state: 'idle',
    });
    const offline = await app!.inject({
      method: 'POST', url: '/api/sessions/session-restore-offline-st/files/restore?path=selected.txt',
    });
    expect(offline.statusCode).toBe(500);
    expect(offline.json().error).toContain('runner offline');
    await expect(readFile(join(root, 'selected.txt'), 'utf8')).resolves.toBe('must survive offline request\n');
  });

  it('authorizes workspace file operations and forwards container-aware runner RPC', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Artifact Operator', email: 'artifact@example.com', password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const bytes = Buffer.from([0, 17, 128, 255, 10]);
    const archiveBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x7f, 0xff]);
    const uploadedBytes = Buffer.from([255, 0, 128, 13, 10]);
    let uploaded: Buffer | undefined;
    let deletedPath: string | undefined;
    let createdDirectory: string | undefined;
    let renamedEntry: { path: string; newName: string } | undefined;
    let movedEntry: { path: string; destinationPath: string } | undefined;
    let copiedEntry: { path: string; destinationPath: string } | undefined;
    let changedMode: { path: string; executable: boolean } | undefined;
    const runner = await FakeRunner.connect(baseUrl, {
      'workspace.list': (params) => {
        expect(params).toEqual({ root: '/tmp/artifact-work', path: '', containerId: 'artifact-container' });
        return {
          ok: true,
          path: '',
          entries: [
            { name: 'out', type: 'directory' },
            { name: 'summary.txt', type: 'file', size: 12, executable: true },
          ],
          truncated: false,
        };
      },
      'workspace.search': (params) => {
        expect(params).toEqual({ root: '/tmp/artifact-work', query: 'result', containerId: 'artifact-container' });
        return {
          ok: true,
          matches: [{ path: 'out/result.bin', type: 'file', size: bytes.length }],
          truncated: false,
        };
      },
      'workspace.searchContent': (params) => {
        expect(params).toEqual({ root: '/tmp/artifact-work', query: 'release ready', containerId: 'artifact-container' });
        return {
          ok: true,
          matches: [{ path: 'src/main.ts', line: 7, preview: 'const releaseReady = true;' }],
          truncated: false,
        };
      },
      'workspace.read': (params) => {
        expect(params).toEqual({ root: '/tmp/artifact-work', path: 'out/result.bin', containerId: 'artifact-container' });
        return { ok: true, basename: 'result.bin', size: bytes.length, data: bytes.toString('base64') };
      },
      'workspace.archive': (params) => {
        expect(params).toEqual({ root: '/tmp/artifact-work', path: 'out/reports', containerId: 'artifact-container' });
        return {
          ok: true,
          basename: 'reports.tar.gz',
          size: archiveBytes.length,
          data: archiveBytes.toString('base64'),
        };
      },
      'workspace.extract': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'out/reports.tar.gz', containerId: 'artifact-container',
        });
        return { ok: true, entries: 4 };
      },
      'workspace.write': (params) => {
        expect(params).toMatchObject({
          root: '/tmp/artifact-work', path: 'out/upload.bin', containerId: 'artifact-container', size: uploadedBytes.length,
        });
        uploaded = Buffer.from((params as { data: string }).data, 'base64');
        return { ok: true, size: uploaded?.length };
      },
      'workspace.chmod': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'out/run.sh', executable: false, containerId: 'artifact-container',
        });
        changedMode = params as { path: string; executable: boolean };
        return { ok: true, executable: false };
      },
      'workspace.delete': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'out/old.bin', containerId: 'artifact-container',
        });
        deletedPath = (params as { path: string }).path;
        return { ok: true };
      },
      'workspace.mkdir': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'out/new-folder', containerId: 'artifact-container',
        });
        createdDirectory = (params as { path: string }).path;
        return { ok: true };
      },
      'workspace.rename': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'out/draft', newName: 'final', containerId: 'artifact-container',
        });
        renamedEntry = params as { path: string; newName: string };
        return { ok: true, path: 'out/final' };
      },
      'workspace.move': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'reports/draft', destinationPath: 'archive/draft', containerId: 'artifact-container',
        });
        movedEntry = params as { path: string; destinationPath: string };
        return { ok: true, path: 'archive/draft' };
      },
      'workspace.copy': (params) => {
        expect(params).toEqual({
          root: '/tmp/artifact-work', path: 'reports/final', destinationPath: 'archive/final-copy', containerId: 'artifact-container',
        });
        copiedEntry = params as { path: string; destinationPath: string };
        return { ok: true, path: 'archive/final-copy' };
      },
    });
    runners.push(runner);
    await runner.callServer('machine.register', {
      info: { id: 'm-artifact', name: 'Artifact Runner', labels: ['dev'], resources: [], runnerVersion: 'st', startedAt: Date.now() },
    });
    await getDb().insert(schema.sessions).values({
      id: 'session-artifact-st', machineId: 'm-artifact', agent: 'claude', cwd: '/tmp/artifact-work',
      containerId: 'artifact-container', state: 'idle',
    });

    const unauthorizedListing = await app!.inject({
      method: 'GET', url: '/api/sessions/session-artifact-st/files/list?path=', headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedListing.statusCode).toBe(401);
    const unauthorizedSearch = await app!.inject({
      method: 'GET', url: '/api/sessions/session-artifact-st/files/search?q=result', headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedSearch.statusCode).toBe(401);
    const unauthorizedContentSearch = await app!.inject({
      method: 'GET', url: '/api/sessions/session-artifact-st/files/search-content?q=release%20ready', headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedContentSearch.statusCode).toBe(401);
    const unauthorized = await app!.inject({
      method: 'GET', url: '/api/sessions/session-artifact-st/files?path=out%2Fresult.bin', headers: { host: 'localhost:7620' },
    });
    expect(unauthorized.statusCode).toBe(401);
    const unauthorizedArchive = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files/archive?path=out%2Freports',
      headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedArchive.statusCode).toBe(401);
    const unauthorizedExtract = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/extract?path=out%2Freports.tar.gz',
      headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedExtract.statusCode).toBe(401);
    const unauthorizedUpload = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fupload.bin',
      headers: { host: 'localhost:7620', 'content-type': 'application/octet-stream' },
      payload: uploadedBytes,
    });
    expect(unauthorizedUpload.statusCode).toBe(401);
    const unauthorizedDelete = await app!.inject({
      method: 'DELETE',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fold.bin',
      headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedDelete.statusCode).toBe(401);
    const unauthorizedChmod = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-artifact-st/files/executable?path=out%2Frun.sh',
      headers: { host: 'localhost:7620', 'content-type': 'application/json' },
      payload: { executable: false },
    });
    expect(unauthorizedChmod.statusCode).toBe(401);
    const unauthorizedMkdir = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/directories?path=out%2Fnew-folder',
      headers: { host: 'localhost:7620' },
    });
    expect(unauthorizedMkdir.statusCode).toBe(401);
    const unauthorizedRename = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fdraft',
      headers: { host: 'localhost:7620', 'content-type': 'application/json' },
      payload: { name: 'final' },
    });
    expect(unauthorizedRename.statusCode).toBe(401);
    const unauthorizedMove = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/move?path=reports%2Fdraft',
      headers: { host: 'localhost:7620', 'content-type': 'application/json' },
      payload: { destinationPath: 'archive/draft' },
    });
    expect(unauthorizedMove.statusCode).toBe(401);
    const unauthorizedCopy = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/copy?path=reports%2Ffinal',
      headers: { host: 'localhost:7620', 'content-type': 'application/json' },
      payload: { destinationPath: 'archive/final-copy' },
    });
    expect(unauthorizedCopy.statusCode).toBe(401);
    const listing = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files/list?path=',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({
      path: '',
      entries: [
        { name: 'out', type: 'directory' },
        { name: 'summary.txt', type: 'file', size: 12, executable: true },
      ],
      truncated: false,
    });
    const search = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files/search?q=result',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual({
      matches: [{ path: 'out/result.bin', type: 'file', size: bytes.length }],
      truncated: false,
    });
    const contentSearch = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files/search-content?q=release%20ready',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(contentSearch.statusCode).toBe(200);
    expect(contentSearch.json()).toEqual({
      matches: [{ path: 'src/main.ts', line: 7, preview: 'const releaseReady = true;' }],
      truncated: false,
    });
    const downloaded = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fresult.bin',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-disposition']).toContain('result.bin');
    expect(downloaded.rawPayload).toEqual(bytes);
    const downloadedArchive = await app!.inject({
      method: 'GET',
      url: '/api/sessions/session-artifact-st/files/archive?path=out%2Freports',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(downloadedArchive.statusCode).toBe(200);
    expect(downloadedArchive.headers['content-type']).toBe('application/gzip');
    expect(downloadedArchive.headers['content-length']).toBe(String(archiveBytes.length));
    expect(downloadedArchive.headers['content-disposition']).toContain('reports.tar.gz');
    expect(downloadedArchive.rawPayload).toEqual(archiveBytes);
    const extractedArchive = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/extract?path=out%2Freports.tar.gz',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(extractedArchive.statusCode).toBe(200);
    expect(extractedArchive.json()).toEqual({ ok: true, path: 'out/reports.tar.gz', entries: 4 });
    const upload = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fupload.bin',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/octet-stream' },
      payload: uploadedBytes,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toEqual({ ok: true, path: 'out/upload.bin', size: uploadedBytes.length });
    expect(uploaded).toEqual(uploadedBytes);
    const chmod = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-artifact-st/files/executable?path=out%2Frun.sh',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/json' },
      payload: { executable: false },
    });
    expect(chmod.statusCode).toBe(200);
    expect(chmod.json()).toEqual({ ok: true, path: 'out/run.sh', executable: false });
    expect(changedMode).toEqual({
      root: '/tmp/artifact-work', path: 'out/run.sh', executable: false, containerId: 'artifact-container',
    });
    const deletion = await app!.inject({
      method: 'DELETE',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fold.bin',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toEqual({ ok: true, path: 'out/old.bin' });
    expect(deletedPath).toBe('out/old.bin');
    const creation = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/directories?path=out%2Fnew-folder',
      headers: { host: 'localhost:7620', cookie },
    });
    expect(creation.statusCode).toBe(201);
    expect(creation.json()).toEqual({ ok: true, path: 'out/new-folder' });
    expect(createdDirectory).toBe('out/new-folder');
    const rename = await app!.inject({
      method: 'PATCH',
      url: '/api/sessions/session-artifact-st/files?path=out%2Fdraft',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/json' },
      payload: { name: 'final' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toEqual({ ok: true, path: 'out/final' });
    expect(renamedEntry).toEqual({
      root: '/tmp/artifact-work', path: 'out/draft', newName: 'final', containerId: 'artifact-container',
    });
    const move = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/move?path=reports%2Fdraft',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/json' },
      payload: { destinationPath: 'archive/draft' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json()).toEqual({ ok: true, path: 'archive/draft' });
    expect(movedEntry).toEqual({
      root: '/tmp/artifact-work', path: 'reports/draft', destinationPath: 'archive/draft', containerId: 'artifact-container',
    });
    const copy = await app!.inject({
      method: 'POST',
      url: '/api/sessions/session-artifact-st/files/copy?path=reports%2Ffinal',
      headers: { host: 'localhost:7620', cookie, 'content-type': 'application/json' },
      payload: { destinationPath: 'archive/final-copy' },
    });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toEqual({ ok: true, path: 'archive/final-copy' });
    expect(copiedEntry).toEqual({
      root: '/tmp/artifact-work', path: 'reports/final', destinationPath: 'archive/final-copy', containerId: 'artifact-container',
    });
    expect(runner.calls.some((call) => call.method === 'workspace.list')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.search')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.searchContent')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.read')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.archive')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.extract')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.write')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.chmod')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.delete')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.mkdir')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.rename')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.move')).toBe(true);
    expect(runner.calls.some((call) => call.method === 'workspace.copy')).toBe(true);
  });

  it('posts forge comments through authenticated refs with the requester token', async () => {
    await app!.close();
    app = null;
    await closeDb();
    await startApp(true);

    const email = 'forge-retest@example.com';
    const signUp = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: 'localhost:7620', origin: 'http://localhost:7620' },
      payload: { name: 'Forge Operator', email, password: 'system-test-password' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    expect(cookie).not.toBe('');

    const db = getDb();
    const [operator] = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email)).limit(1);
    expect(operator).toBeDefined();
    await db.insert(schema.authUser).values({ id: 'other-user', name: 'Other', email: 'other@example.com' });
    await db.insert(schema.forgeTokens).values([
      { userId: 'other-user', forge: 'gitcode', tokenEnc: encryptSecret('wrong-user-token') },
      { userId: operator!.id, forge: 'gitcode', tokenEnc: encryptSecret('requester-gitcode-token') },
      { userId: operator!.id, forge: 'github', tokenEnc: encryptSecret('requester-github-token') },
    ]);
    await db.insert(schema.forgeRefs).values({
      id: 'gitcode-retest-ref',
      forge: 'gitcode',
      kind: 'pr',
      repo: 'mindspore/mindformers',
      number: 8377,
      runId: 'run-retest',
      active: 'yes',
    });
    await db.insert(schema.forgeRefs).values({
      id: 'github-comment-ref',
      forge: 'github',
      kind: 'pr',
      repo: 'acme/widgets',
      number: 42,
      runId: 'run-comment',
      active: 'yes',
    });

    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 901 }));
    const response = await app!.inject({
      method: 'POST',
      url: '/api/forge/refs/gitcode-retest-ref/retest',
      headers: { host: 'localhost:7620', cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, confirmation: 'pending' });
    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0]!;
    expect(url).toBe('https://api.gitcode.com/api/v5/repos/mindspore/mindformers/pulls/8377/comments');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ body: '/retest' }) });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer requester-gitcode-token');

    outbound.mockClear();
    outbound.mockResolvedValue(Response.json({ id: 902 }));
    const comment = await app!.inject({
      method: 'POST',
      url: '/api/forge/refs/github-comment-ref/comments',
      headers: { host: 'localhost:7620', cookie },
      payload: { body: '  Please rerun the failed checks.  ' },
    });

    expect(comment.statusCode).toBe(200);
    expect(comment.json()).toEqual({ ok: true, commentId: 902 });
    expect(outbound).toHaveBeenCalledTimes(1);
    const [commentUrl, commentInit] = outbound.mock.calls[0]!;
    expect(commentUrl).toBe('https://api.github.com/repos/acme/widgets/issues/42/comments');
    expect(commentInit).toMatchObject({ method: 'POST', body: JSON.stringify({ body: 'Please rerun the failed checks.' }) });
    expect((commentInit?.headers as Record<string, string>).authorization).toBe('Bearer requester-github-token');
  });
});
