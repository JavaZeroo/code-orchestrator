import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@co/protocol';
import { resolveRunMachine } from './runMachine';

const M = (id: string, labels: string[] = []): MachineInfo =>
  ({ id, name: id, labels, resources: [], startedAt: 0 });

describe('resolveRunMachine', () => {
  it('最新会话机在线 → 用它（即使排在 npu 之后）', () => {
    expect(resolveRunMachine([M('npu'), M('dev', ['dev'])], 'dev', [{ labels: ['dev'] }])).toBe('dev');
  });
  it('最新会话机离线 → 回退 agent 选择器命中', () => {
    expect(resolveRunMachine([M('dev', ['dev']), M('npu')], 'gone', [{ labels: ['dev'] }])).toBe('dev');
  });
  it('无会话 + 选择器命中', () => {
    expect(resolveRunMachine([M('dev', ['dev'])], null, [{ labels: ['dev'] }])).toBe('dev');
  });
  it('都不命中 → null（调用方响亮失败）', () => {
    expect(resolveRunMachine([M('npu', ['npu'])], null, [{ labels: ['dev'] }])).toBeNull();
  });
  it('单机 + 会话在线 → 行为不变', () => {
    expect(resolveRunMachine([M('solo')], 'solo', [])).toBe('solo');
  });
  it('最新会话机暂停调度 → 跳过并回退到可调度的 selector 机器', () => {
    const paused = M('paused', ['dev']);
    paused.schedulingPaused = true;
    expect(resolveRunMachine([paused, M('active', ['dev'])], 'paused', [{ labels: ['dev'] }])).toBe('active');
  });
  it('显式 selector 指向暂停调度机 → null', () => {
    const paused = M('paused');
    paused.schedulingPaused = true;
    expect(resolveRunMachine([paused], null, [{ id: 'paused' }])).toBeNull();
  });
});
