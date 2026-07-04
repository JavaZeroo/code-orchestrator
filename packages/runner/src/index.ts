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
  runnerVersion: '0.1.0',
  codeServerUrl: config.codeServerUrl,
  startedAt: Date.now(),
};

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
      conn.call('machine.heartbeat', { machineId: info.id, sessions: listSessionStates() }).catch((err) => {
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
