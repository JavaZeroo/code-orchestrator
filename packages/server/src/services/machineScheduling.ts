import type { MachineInfo } from '@co/protocol';

/** 调度暂停只影响新放置；机器仍在线，已有会话继续经 runner 通信。 */
export function isMachineSchedulable(machine: MachineInfo): boolean {
  return machine.schedulingPaused !== true;
}

/** 所有新任务放置路径共用的在线机过滤器。 */
export function schedulableMachines<T extends MachineInfo>(machines: readonly T[]): T[] {
  return machines.filter(isMachineSchedulable);
}
