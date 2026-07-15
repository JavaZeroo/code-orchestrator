import type { CommandExecutionRequest } from './capabilityLoop';

export type EvaluatorRunnerCall =
  | {
    method: 'machine.exec';
    params: { cmd: string; cwd: string; timeoutMs: number };
  }
  | {
    method: 'container.exec';
    params: { containerId: string; cmd: string; workdir: string; timeoutMs: number };
  };

export type RepositoryInstructionRunnerCall =
  | { method: 'workspace.read'; params: { root: string; path: string } }
  | {
    method: 'container.exec';
    params: { containerId: string; cmd: string; workdir: string; timeoutMs: number };
  };

/** 把 Evaluator 的逻辑 cwd 映射到 Agent 真正拥有的宿主 worktree 或容器 workspace。 */
export function evaluatorRunnerCall(
  workspace: { cwd: string; containerId?: string | null },
  request: CommandExecutionRequest,
): EvaluatorRunnerCall {
  if (workspace.containerId) {
    return {
      method: 'container.exec',
      params: {
        containerId: workspace.containerId,
        cmd: request.command,
        workdir: request.cwd,
        timeoutMs: request.timeoutMs,
      },
    };
  }
  return {
    method: 'machine.exec',
    params: { cmd: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs },
  };
}

export function repositoryInstructionRunnerCall(
  workspace: { cwd: string; containerId?: string | null },
  path: string,
): RepositoryInstructionRunnerCall {
  if (!workspace.containerId) {
    return { method: 'workspace.read', params: { root: workspace.cwd, path } };
  }
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  return {
    method: 'container.exec',
    params: {
      containerId: workspace.containerId,
      workdir: workspace.cwd,
      cmd: `if [ -f ${quoted} ]; then printf 'FOUND\\n'; base64 ${quoted} | tr -d '\\n'; fi`,
      timeoutMs: 10_000,
    },
  };
}
