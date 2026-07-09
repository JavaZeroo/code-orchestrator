import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { installAuthGuard, mountAuthRoutes } from './auth';
import { env } from './env';
import { hasDb } from './db/index';
import { resumeActiveRuns, startEngine } from './engine/engine';
import { startForgePoller } from './forge/poller';
import { startIntakePoller } from './forge/intake';
import { startLarkNotifier } from './lark/notifier';
import { registerForgeRoutes } from './routes/forge';
import { registerLarkRoutes } from './routes/lark';
import { registerLlmRoutes } from './routes/llm';
import { registerMeRoutes } from './routes/me';
import { registerProjectRoutes } from './routes/projects';
import { registerSessionRoutes } from './routes/sessions';
import { registerComponentRoutes } from './routes/components';
import { registerTriggerRoutes } from './routes/triggers';
import { registerWorkRoutes } from './routes/work';
import { registerWorkflowRoutes } from './routes/workflows';
import { startAutoMergeReconciler } from './services/autoMerge';
import { rebuildWorkItems, startWorkProjector } from './services/workProjector';
import { registerClientHub } from './ws/clientHub';
import { listMachines, registerRunnerHub } from './ws/runnerHub';

// 容器/正式部署：启动时自动应用迁移（幂等，基于 journal）。开发环境用 drizzle-kit push 时设 RUN_MIGRATIONS=0。
if (hasDb() && process.env.RUN_MIGRATIONS === '1') {
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { getDb } = await import('./db/index');
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../drizzle');
  await migrate(getDb(), { migrationsFolder });
  console.log('[db] migrations applied');
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

const authEnabled = hasDb() && Boolean(env.AUTH_SECRET);
if (authEnabled) {
  mountAuthRoutes(app);
  installAuthGuard(app);
} else {
  app.log.warn('AUTH_SECRET 或 DATABASE_URL 未配置——API 未鉴权运行（仅限开发骨架）');
}

const { version } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
) as { version: string };

app.get('/health', async () => ({
  ok: true,
  db: hasDb(),
  auth: authEnabled,
  time: Date.now(),
  uptime: Math.floor(process.uptime()),
  version,
}));

app.get('/api/machines', async () => ({ machines: listMachines() }));

// —— 添加机器闭环：UI 建行→发每机凭证→runner 携凭证连入绑定（runnerHub 校验） ——
app.post('/api/machines', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const z = await import('zod');
  const body = z.object({
    name: z.string().trim().min(1).max(64),
    labels: z.array(z.string().trim().min(1)).default([]),
  }).parse(req.body);
  const { getDb, schema } = await import('./db/index');
  const { createId } = await import('@paralleldrive/cuid2');
  const { randomBytes } = await import('node:crypto');
  const id = body.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || createId();
  const enrollToken = `co-mk-${randomBytes(24).toString('base64url')}`;
  try {
    await getDb().insert(schema.machines).values({ id, name: body.name, labels: body.labels, status: 'offline', enrollToken });
  } catch {
    return reply.code(409).send({ error: `机器 id 已存在: ${id}` });
  }
  void reply.code(201);
  return { id, enrollToken };
});

app.patch('/api/machines/:id', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const z = await import('zod');
  const body = z.object({
    name: z.string().trim().min(1).max(64).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
  }).parse(req.body);
  if (Object.keys(body).length === 0) return reply.code(400).send({ error: '无更新字段' });
  const { getDb, schema } = await import('./db/index');
  const { eq } = await import('drizzle-orm');
  const id = (req.params as { id: string }).id;
  await getDb().update(schema.machines).set(body).where(eq(schema.machines.id, id));
  // 在线机同步内存（调度真源）
  const conn = listMachines().find((m) => m.id === id);
  if (conn) Object.assign(conn, body);
  return { ok: true };
});

app.delete('/api/machines/:id', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const id = (req.params as { id: string }).id;
  if (listMachines().some((m) => m.id === id)) {
    return reply.code(409).send({ error: '机器在线，不能删除（先停掉该机 runner）' });
  }
  const { getDb, schema } = await import('./db/index');
  const { eq } = await import('drizzle-orm');
  await getDb().delete(schema.machines).where(eq(schema.machines.id, id));
  return { ok: true };
});

app.post('/api/machines/:id/token', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const { getDb, schema } = await import('./db/index');
  const { eq } = await import('drizzle-orm');
  const { randomBytes } = await import('node:crypto');
  const id = (req.params as { id: string }).id;
  const enrollToken = `co-mk-${randomBytes(24).toString('base64url')}`;
  await getDb().update(schema.machines).set({ enrollToken }).where(eq(schema.machines.id, id));
  return { enrollToken };
});

// 资源面板：在线机加速器占用（总数 vs 活跃预留）+ 排队任务数——「哪台机有空闲 NPU」一眼可见
app.get('/api/resources', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const { getDb, schema } = await import('./db/index');
  const { inArray, eq: eqOp } = await import('drizzle-orm');
  const online = listMachines();
  const db = getDb();
  const reservations = online.length
    ? await db
        .select({ machineId: schema.resourceReservations.machineId })
        .from(schema.resourceReservations)
        .where(inArray(schema.resourceReservations.status, ['reserved', 'active']))
    : [];
  const usedBy = new Map<string, number>();
  for (const r of reservations) usedBy.set(r.machineId, (usedBy.get(r.machineId) ?? 0) + 1);
  const queued = await db
    .select({ id: schema.taskQueue.id })
    .from(schema.taskQueue)
    .where(eqOp(schema.taskQueue.status, 'pending'));
  return {
    machines: online.map((m) => {
      const byKind = new Map<string, number>();
      for (const r of m.resources ?? []) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
      return {
        id: m.id,
        labels: m.labels,
        accels: [...byKind.entries()].map(([kind, total]) => ({ kind, total })),
        used: usedBy.get(m.id) ?? 0,
      };
    }),
    queued: queued.length,
  };
});

// 全量机器列表（含离线机）—— 供设置页机器管理。与 /api/machines 并存，语义不同。
app.get('/api/machines/all', async (req, reply) => {
  if (!hasDb()) return reply.code(503).send({ error: 'database not available' });
  const { getDb, schema } = await import('./db/index');
  const rows = await getDb().select().from(schema.machines);
  return { machines: rows };
});

await registerRunnerHub(app);
registerClientHub(app, authEnabled);
await registerSessionRoutes(app);
await registerWorkflowRoutes(app);
await registerForgeRoutes(app);
await registerTriggerRoutes(app);
await registerComponentRoutes(app);
await registerWorkRoutes(app);
await registerProjectRoutes(app);
if (authEnabled) {
  await registerMeRoutes(app);
  await registerLarkRoutes(app);
  await registerLlmRoutes(app);
}

if (hasDb()) {
  startEngine();
  await resumeActiveRuns();
  startForgePoller();
  startIntakePoller();
  startLarkNotifier();
  // Work-Item 控制平面：先订阅实时事件，再后台从事件日志回放补齐历史（幂等）
  startWorkProjector();
  void rebuildWorkItems()
    .then((n) => console.log(`[work] backfilled from ${n} events`))
    .catch((err) => console.error('[work] backfill failed:', err));
  // Auto-merge 控制回路：能力常开，开关在 Project.autonomy（用户按项目拨）
  startAutoMergeReconciler();
}

// 生产形态：托管 web 构建产物（pnpm --filter @co/web build 后生效）
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}

// TODO: better-auth 挂载（决策 §12.2）

await app.listen({ port: env.PORT, host: env.HOST });

// 容器/卡预留回收（design-v2 #39）：死会话的容器 rm + 卡释放，防泄漏挡后续调度
void import('./services/containerGc').then((m) => m.startContainerGc());
