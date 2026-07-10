import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@co/protocol';
import { resolveInteractiveMachine } from './spawnAuto';

function machine(id: string, opts: Partial<MachineInfo> = {}): MachineInfo {
  return { id, name: id, labels: [], resources: [], startedAt: 0, ...opts };
}

describe('resolveInteractiveMachine', () => {
  it('无在线机 → null', () => {
    expect(resolveInteractiveMachine([], [])).toBeNull();
  });

  it('ready 物化机在线 → 命中（黏性优先于 dev）', () => {
    const online = [
      machine('m1', { labels: ['dev'] }),
      machine('m2'),
      machine('m3'),
    ];
    // m2 有 ready 物化 → 应选 m2，而非 dev m1
    expect(resolveInteractiveMachine(online, ['m2'])).toBe('m2');
  });

  it('无 ready、有 dev → dev', () => {
    const online = [
      machine('m1'),
      machine('m2', { labels: ['dev'] }),
      machine('m3'),
    ];
    expect(resolveInteractiveMachine(online, [])).toBe('m2');
  });

  it('无 ready/无 dev、唯一在线 → 该机', () => {
    const online = [machine('only')];
    expect(resolveInteractiveMachine(online, [])).toBe('only');
  });

  it('无 ready/无 dev、多台 → null（不赌）', () => {
    const online = [
      machine('m1'),
      machine('m2'),
      machine('m3'),
    ];
    expect(resolveInteractiveMachine(online, [])).toBeNull();
  });

  it('跳过暂停调度机，且恢复后可再次命中', () => {
    const sticky = machine('sticky', { schedulingPaused: true });
    const dev = machine('dev', { labels: ['dev'] });

    expect(resolveInteractiveMachine([sticky, dev], ['sticky'])).toBe('dev');
    expect(resolveInteractiveMachine([sticky], ['sticky'])).toBeNull();
    sticky.schedulingPaused = false;
    expect(resolveInteractiveMachine([sticky], ['sticky'])).toBe('sticky');
  });
});
