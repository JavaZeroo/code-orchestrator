/**
 * 容器会话驱动（design-v2 #37，runner 侧）：不在宿主进程内起 SDK，而是
 *   `docker exec -i <容器> <node> <agent.mjs>`——agent 在训练容器内跑（bash/msrun 都在训练环境）。
 * 把子进程 stdio 桥回现有 uplink：子进程 stdout(JSON 行)→ emit；send/decide/kill/interrupt → 子进程 stdin。
 * 与 ClaudeSession 同接口（RunnerSession），methods.ts 统一登记/操作。
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createEnvelope } from '@co/protocol';
import type { ApprovalDecision, ApprovalRequest, MessageMeta, SessionAgent, SessionEnvelope, SessionState } from '@co/protocol';
import type { DriverEmit, SessionUsage } from '../driverTypes';
import type { RunnerSession } from '../sessions';

export interface ContainerSpawnParams {
  sessionId: string;
  containerId: string;
  /** 容器内 node 路径（挂载注入，如 /opt/co/node） */
  nodePath: string;
  /** 容器内 agent 入口（如 /opt/co/agent.mjs） */
  agentMjs: string;
  /** 传给 agent.mjs 的会话参数（cwd=/workspace、prompt、meta 等） */
  agentParams: {
    sessionId: string;
    agent: SessionAgent;
    cwd: string;
    prompt?: string;
    meta?: MessageMeta;
    env?: Record<string, string>;
  };
}

type OutMsg =
  | { t: 'ready'; sessionId: string }
  | { t: 'event'; envelope: SessionEnvelope }
  | { t: 'state'; state: SessionState; nativeSessionId?: string; usage?: SessionUsage }
  | { t: 'approval'; request: ApprovalRequest }
  | { t: 'warn' | 'fatal'; message: string };

export class ContainerSession implements RunnerSession {
  readonly sessionId: string;
  state: SessionState = 'starting';
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';

  constructor(
    private readonly params: ContainerSpawnParams,
    private readonly emit: DriverEmit,
  ) {
    this.sessionId = params.sessionId;
  }

  start(): void {
    const json = JSON.stringify(this.params.agentParams);
    // 容器已在 container.run 时注入模型/forge env（ANTHROPIC_* 等）；exec 继承之，这里只补 CO_SESSION_PARAMS
    const child = spawn('docker', ['exec', '-i', '-e', `CO_SESSION_PARAMS=${json}`, this.params.containerId, this.params.nodePath, this.params.agentMjs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) {
        console.error(`[container-session ${this.sessionId}] stderr: ${s.slice(0, 500)}`);
      }
    });
    child.on('exit', (code) => {
      if (this.state !== 'dead') {
        this.emit.event(createEnvelope('agent', { t: 'service', text: `容器内 agent 退出 (code=${code})` }));
        this.setState('dead');
      }
    });
    child.on('error', (err) => {
      this.emit.event(createEnvelope('agent', { t: 'service', text: `docker exec 失败: ${err.message}` }));
      this.setState('dead');
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg: OutMsg;
      try {
        msg = JSON.parse(line) as OutMsg;
      } catch {
        continue; // 非 JSON 行（容器噪声）忽略
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: OutMsg): void {
    switch (msg.t) {
      case 'event':
        this.emit.event(msg.envelope);
        break;
      case 'state':
        this.setState(msg.state, msg.nativeSessionId, msg.usage);
        break;
      case 'approval':
        this.emit.approval(msg.request);
        break;
      case 'warn':
      case 'fatal':
        console.error(`[container-session ${this.sessionId}] ${msg.t}: ${msg.message}`);
        break;
      case 'ready':
        break;
    }
  }

  private setState(state: SessionState, nativeSessionId?: string, usage?: SessionUsage): void {
    if (this.state === 'dead') {
      return;
    }
    this.state = state;
    this.emit.state(state, nativeSessionId, usage);
  }

  private write(cmd: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  send(text: string, meta?: MessageMeta): void {
    this.write({ t: 'send', text, meta });
  }

  async interrupt(): Promise<boolean> {
    this.write({ t: 'interrupt' });
    return true;
  }

  decideApproval(approvalId: string, decision: ApprovalDecision): boolean {
    this.write({ t: 'decide', approvalId, decision });
    return true;
  }

  kill(): void {
    this.write({ t: 'kill' });
    this.child?.stdin.end();
    this.setState('dead');
    // 给容器内 agent 一点收尾时间，再硬杀 exec 子进程
    setTimeout(() => this.child?.kill('SIGKILL'), 1500);
  }
}
