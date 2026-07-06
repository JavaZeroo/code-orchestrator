/**
 * 容器内 agent 入口（design-v2 #37）：在训练容器里跑 SDK 循环，其 bash/msrun/npu-smi/读日志都在训练环境内。
 * 复用 runner 的 ClaudeSession，只把「WS uplink」换成「stdio 传输」——
 *   stdin  ← host-runner 下发的命令（send/interrupt/decide/kill），每行一个 JSON
 *   stdout → 事件/状态/审批上报（每行一个 JSON），host-runner 桥回现有 uplink
 * 打包成自包含 agent.mjs（esbuild，SDK external），挂进容器用挂载的 node 执行。
 */

import { ClaudeSession, type DriverEmit } from '../claude/driver';
import type { RunnerParams } from '@co/protocol';

function out(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function fail(message: string): never {
  out({ t: 'fatal', message });
  process.exit(1);
}

const raw = process.env.CO_SESSION_PARAMS;
if (!raw) {
  fail('CO_SESSION_PARAMS 未注入');
}
let params: RunnerParams<'session.spawn'>;
try {
  params = JSON.parse(raw) as RunnerParams<'session.spawn'>;
} catch (e) {
  fail(`CO_SESSION_PARAMS 解析失败: ${e instanceof Error ? e.message : String(e)}`);
}

const emit: DriverEmit = {
  event: (envelope) => out({ t: 'event', envelope }),
  state: (state, nativeSessionId, usage) => out({ t: 'state', state, nativeSessionId, usage }),
  approval: (request) => out({ t: 'approval', request }),
  draft: async () => ({ ok: false, error: 'designer 不在容器内运行' }),
};

const session = new ClaudeSession(params, emit);
session.start();
out({ t: 'ready', sessionId: params.sessionId });

// stdin：按行解析命令
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line) as Command);
    } catch (e) {
      out({ t: 'warn', message: `bad command: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
});

interface Command {
  t: 'send' | 'interrupt' | 'decide' | 'kill';
  text?: string;
  meta?: RunnerParams<'session.spawn'>['meta'];
  approvalId?: string;
  decision?: Parameters<typeof session.decideApproval>[1];
}

function handle(cmd: Command): void {
  switch (cmd.t) {
    case 'send':
      if (cmd.text) {
        session.send(cmd.text, cmd.meta);
      }
      break;
    case 'interrupt':
      void session.interrupt();
      break;
    case 'decide':
      if (cmd.approvalId && cmd.decision) {
        session.decideApproval(cmd.approvalId, cmd.decision);
      }
      break;
    case 'kill':
      session.kill();
      process.exit(0);
  }
}
