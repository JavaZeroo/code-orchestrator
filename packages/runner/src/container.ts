/**
 * 容器驱动（design-v2 Q3，M1 substrate）：co 拥有容器——本机 docker run/exec/rm。
 * 卡在建容器时绑定（devices/gpus），容器活着=资源被占，销毁即释放（Q11）。
 * 注：agent 进容器执行（其 bash 见 CANN/python 环境）走 container.exec；driver 侧接线在 #31。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams } from '@co/protocol';
import { config } from './config';

const run = promisify(execFile);
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** 把 container.run 参数翻译成 docker run argv。 */
export function buildContainerRunArgs(p: RunnerParams<'container.run'>): string[] {
  const args = ['run', '-d'];
  if (p.name) {
    args.push('--name', p.name);
  }
  // co 归属 label：宿主 docker 多方共享，孤儿回收只敢按 label 精确过滤（严禁宽泛 name 匹配）
  args.push('--label', 'co.managed=true', '--label', `co.runner=${config.machineId}`);
  if (p.workdir) {
    args.push('-w', p.workdir);
  }
  for (const m of p.mounts) {
    args.push('-v', `${m.host}:${m.container}${m.ro ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(p.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  for (const d of p.devices) {
    args.push('--device', d);
  }
  if (p.gpus) {
    args.push('--gpus', p.gpus);
  }
  if (p.network) {
    args.push('--network', p.network);
  }
  args.push(...p.extraArgs);
  args.push(p.image);
  if (p.command && p.command.length > 0) {
    args.push(...p.command);
  }
  return args;
}

/** 起容器（-d 守护），返回容器 id。 */
export async function containerRun(
  p: RunnerParams<'container.run'>,
): Promise<{ ok: boolean; containerId?: string; error?: string }> {
  const args = buildContainerRunArgs(p);
  try {
    const { stdout } = await run('docker', args, { maxBuffer: EXEC_MAX_BUFFER });
    return { ok: true, containerId: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 在容器内执行命令（agent 的 bash / EnvComponent activate 都走这里）。 */
export async function containerExec(
  p: RunnerParams<'container.exec'>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = ['exec'];
  if (p.workdir) {
    args.push('-w', p.workdir);
  }
  args.push(p.containerId, 'bash', '-lc', p.cmd);
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: p.timeoutMs ?? 60_000, maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
      let exitCode = 0;
      if (err) {
        exitCode = (err as { killed?: boolean }).killed ? 124 : typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1;
      }
      resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 销毁容器（默认强制），随之释放其占用的卡（Q11：容器生命周期=卡预留）。 */
export async function containerRm(p: RunnerParams<'container.rm'>): Promise<{ ok: boolean; error?: string }> {
  try {
    await run('docker', ['rm', ...(p.force ? ['-f'] : []), p.containerId], { maxBuffer: EXEC_MAX_BUFFER });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 回收本 runner 上一生命周期遗留的 co 容器（runner 重启后旧容器失去 stdin 桥，
 * agent 无法再通信却继续占卡——Q11：容器活着=卡被占）。
 * 仅在进程启动时、向 server 注册前调用一次；按 label 精确过滤，绝不碰他人的容器。
 * 主开发容器内可能没有 docker CLI——失败只告警，不影响启动。
 */
export async function reapOrphanContainers(): Promise<void> {
  let stdout: string;
  try {
    const result = await run(
      'docker',
      ['ps', '--filter', 'label=co.managed=true', '--filter', `label=co.runner=${config.machineId}`, '--format', '{{.ID}} {{.Names}}'],
      { maxBuffer: EXEC_MAX_BUFFER },
    );
    stdout = result.stdout;
  } catch (err) {
    console.warn(`[runner] orphan container sweep skipped: ${err instanceof Error ? err.message : err}`);
    return;
  }
  for (const line of stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const id = line.split(/\s+/)[0]!;
    try {
      await run('docker', ['rm', '-f', id], { maxBuffer: EXEC_MAX_BUFFER });
      console.log(`[runner] reaped orphan container: ${line}`);
    } catch (err) {
      console.error(`[runner] failed to reap container ${line}:`, err instanceof Error ? err.message : err);
    }
  }
}
