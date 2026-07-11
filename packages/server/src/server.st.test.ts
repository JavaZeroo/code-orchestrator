import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import WebSocket from 'ws';
import { createApp } from './app';
import { closeDb, getDb, schema } from './db/index';
import { eq } from 'drizzle-orm';
import { encryptSecret } from './services/crypto';
import { markTaskDone, reconcileQueueOnce, type QueuedTask } from './services/taskQueue';
import { getForge } from './forge/registry';

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
  payload: unknown;
}

async function connectClientEvents(baseUrl: string, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/client?sessionId=${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
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

  it('posts /retest through REST with the authenticated requester token', async () => {
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
  });
});
