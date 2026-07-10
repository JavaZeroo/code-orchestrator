import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@co/protocol';
import { getAccelerator } from '../resources/accelerators';
import { cardIndices, chooseMachine } from './scheduler';

function machine(id: string, opts: Partial<MachineInfo> = {}): MachineInfo {
  return { id, name: id, labels: [], resources: [], startedAt: 0, ...opts };
}

const npu8 = (id: string, labels: string[] = []) =>
  machine(id, { labels, resources: Array.from({ length: 8 }, (_, index) => ({ kind: 'ascend-npu', index })) });

describe('chooseMachine', () => {
  it('id 覆盖：在线则返回，离线则 null', () => {
    const online = [machine('a'), machine('b')];
    expect(chooseMachine(online, { id: 'b' })).toBe('b');
    expect(chooseMachine(online, { id: 'z' })).toBeNull();
  });

  it('label 过滤：须含全部 label', () => {
    const online = [machine('a', { labels: ['x'] }), machine('b', { labels: ['x', 'y'] })];
    expect(chooseMachine(online, { labels: ['x', 'y'] })).toBe('b');
    expect(chooseMachine(online, { labels: ['z'] })).toBeNull();
  });

  it('无加速器需求：可选任意机（不看 busy）', () => {
    const online = [machine('a'), machine('b')];
    expect(chooseMachine(online, { busyMachineIds: ['a', 'b'] })).toBe('a');
  });

  it('加速器：须有该 kind 且空闲（一机一任务）', () => {
    const online = [machine('cpu'), npu8('npu1'), npu8('npu2')];
    // npu1 忙 → 落 npu2
    expect(chooseMachine(online, { accelKind: 'ascend-npu', busyMachineIds: ['npu1'] })).toBe('npu2');
    // 全忙 → null（调用方入队）
    expect(chooseMachine(online, { accelKind: 'ascend-npu', busyMachineIds: ['npu1', 'npu2'] })).toBeNull();
    // 没有该 kind 的机器 → null
    expect(chooseMachine([machine('cpu')], { accelKind: 'ascend-npu' })).toBeNull();
  });

  it('黏性：空闲候选中优先已 ready 物化的机器', () => {
    const online = [npu8('npu1'), npu8('npu2')];
    expect(chooseMachine(online, { accelKind: 'ascend-npu', readyMachineIds: ['npu2'] })).toBe('npu2');
  });

  it('暂停调度机不参与自动或显式放置，恢复后重新可用', () => {
    const paused = npu8('paused');
    paused.schedulingPaused = true;
    const active = npu8('active');

    expect(chooseMachine([paused, active], { accelKind: 'ascend-npu' })).toBe('active');
    expect(chooseMachine([paused, active], { id: 'paused' })).toBeNull();
    paused.schedulingPaused = false;
    expect(chooseMachine([paused, active], { id: 'paused' })).toBe('paused');
  });
});

describe('cardIndices', () => {
  it('整机分配：返回该 kind 全部卡 index', () => {
    expect(cardIndices(npu8('npu1'), 'ascend-npu')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cardIndices(npu8('npu1'), 'nvidia-gpu')).toEqual([]);
  });
});

describe('ascend accelerator bindFlags', () => {
  it('产出 /dev/davinci* 设备 + ASCEND_RT_VISIBLE_DEVICES', () => {
    const a = getAccelerator('ascend-npu')!;
    const f = a.bindFlags([0, 1]);
    expect(f.devices).toContain('/dev/davinci0');
    expect(f.devices).toContain('/dev/davinci1');
    expect(f.devices).toContain('/dev/davinci_manager');
    expect(f.env.ASCEND_RT_VISIBLE_DEVICES).toBe('0,1');
  });

  it('未知 kind → null', () => {
    expect(getAccelerator('tpu')).toBeNull();
  });
});
