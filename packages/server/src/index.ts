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
import { startIntakePoller } from './forge/intake';
import { startForgePoller } from './forge/poller';
import { registerForgeRoutes } from './routes/forge';
import { registerMeRoutes } from './routes/me';
import { registerSessionRoutes } from './routes/sessions';
import { registerTriggerRoutes } from './routes/triggers';
import { registerWorkflowRoutes } from './routes/workflows';
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

app.get('/health', async () => ({ ok: true, db: hasDb(), auth: authEnabled, time: Date.now(), version }));

app.get('/api/machines', async () => ({ machines: listMachines() }));

await registerRunnerHub(app);
registerClientHub(app, authEnabled);
await registerSessionRoutes(app);
await registerWorkflowRoutes(app);
await registerForgeRoutes(app);
await registerTriggerRoutes(app);
if (authEnabled) {
  await registerMeRoutes(app);
}

if (hasDb()) {
  startEngine();
  await resumeActiveRuns();
  startForgePoller();
  startIntakePoller();
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
