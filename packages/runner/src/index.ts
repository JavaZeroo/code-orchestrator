import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineInfo } from '@co/protocol';
import { config } from './config';
import { ServerConnection } from './connection';
import { createRunnerMethodHandler, listSessionStates, type RunnerContext } from './methods';

const HEARTBEAT_INTERVAL_MS = 15_000;

const info: MachineInfo = {
  id: config.machineId,
  name: config.machineName,
  labels: config.labels,
  arch: process.arch,
  dataRoot: config.dataRoot,
  resources: config.resources,
  runnerVersion: '0.1.0',
  codeServerUrl: config.codeServerUrl,
  startedAt: Date.now(),
};

/** 扫描 <dataRoot>/co/cache/<组件>/<版本>/ 两级目录（跳过 .fetch-* 等隐藏项）——组件缓存自报（design-machines-env ③） */
function scanComponentCache(): Record<string, string[]> | undefined {
  if (!config.dataRoot) return undefined;
  const root = join(config.dataRoot, 'co', 'cache');
  const out: Record<string, string[]> = {};
  try {
    for (const comp of readdirSync(root, { withFileTypes: true })) {
      if (!comp.isDirectory() || comp.name.startsWith('.')) continue;
      const versions = readdirSync(join(root, comp.name), { withFileTypes: true })
        .filter((v) => v.isDirectory() && !v.name.startsWith('.'))
        .map((v) => v.name)
        .sort();
      if (versions.length) out[comp.name] = versions;
    }
  } catch {
    return undefined; // cache 目录不存在 = 无缓存
  }
  return Object.keys(out).length ? out : undefined;
}

const ctx: RunnerContext = { conn: null };
let heartbeat: NodeJS.Timeout | null = null;

const conn = new ServerConnection({
  url: config.serverUrl,
  token: config.token,
  handler: createRunnerMethodHandler(ctx),
  onConnected: async () => {
    await conn.call('machine.register', { info });
    console.log(`[runner] registered as "${info.id}" labels=[${info.labels.join(',')}] → ${config.serverUrl}`);
    heartbeat = setInterval(() => {
      conn.call('machine.heartbeat', { machineId: info.id, sessions: listSessionStates(), componentCache: scanComponentCache() }).catch((err) => {
        console.error('[runner] heartbeat failed:', err instanceof Error ? err.message : err);
      });
    }, HEARTBEAT_INTERVAL_MS);
  },
  onDisconnected: () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  },
});
ctx.conn = conn;

conn.connect();
