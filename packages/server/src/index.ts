import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { env } from './env';
import { getDb, hasDb } from './db/index';

if (hasDb() && process.env.RUN_MIGRATIONS === '1') {
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../drizzle');
  await migrate(getDb(), { migrationsFolder });
  console.log('[db] migrations applied');
}

const app = await createApp();
await app.listen({ port: env.PORT, host: env.HOST });

void import('./services/containerGc').then((m) => m.startContainerGc());
