/**
 * 容器驱动（design-v2 Q3，M1 substrate）：co 拥有容器——本机 docker run/exec/rm。
 * 卡在建容器时绑定（devices/gpus），容器活着=资源被占，销毁即释放（Q11）。
 * 注：agent 进容器执行（其 bash 见 CANN/python 环境）走 container.exec；driver 侧接线在 #31。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerParams } from '@co/protocol';

const run = promisify(execFile);
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** 把 container.run 参数翻译成 docker run argv。 */
export function buildContainerRunArgs(p: RunnerParams<'container.run'>): string[] {
  const args = ['run', '-d'];
  if (p.name) {
    args.push('--name', p.name);
  }
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
