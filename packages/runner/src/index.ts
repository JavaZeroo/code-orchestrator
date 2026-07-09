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
  const listDirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      return [];
    }
  };
  for (const comp of listDirs(root)) {
    // wheels/ 是三层布局（wheels/<组件>/<key>/），下钻一层按真实组件名归类
    if (comp.name === 'wheels') {
      for (const sub of listDirs(join(root, 'wheels'))) {
        const keys = listDirs(join(root, 'wheels', sub.name)).map((d) => d.name).sort();
        if (keys.length) out[sub.name] = [...(out[sub.name] ?? []), ...keys];
      }
      continue;
    }
    const versions = listDirs(join(root, comp.name)).map((d) => d.name).sort();
    if (versions.length) out[comp.name] = versions;
  }
  // 空对象也要上报——否则删掉缓存后 DB 里的旧值永远清不掉
  return out;
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
