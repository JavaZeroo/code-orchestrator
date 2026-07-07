import { describe, expect, it } from 'vitest';
import { buildInjectedEnv, planModel, type ProviderSnapshot } from './modelResolve';

const P: ProviderSnapshot[] = [
  {
    name: 'anthropic',
    baseUrl: null,
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    defaultModel: null,
    apiKeyEnc: null,
  },
  {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    apiKeyEnc: null,
  },
  {
    name: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: ['glm-4.6'],
    defaultModel: 'glm-4.6',
    apiKeyEnc: null,
  },
  // 模拟迁移来的自定义 endpoint → provider
  {
    name: 'my-custom',
    baseUrl: 'https://custom.example.com/anthropic',
    models: ['custom-model'],
    defaultModel: 'custom-model',
    apiKeyEnc: 'encrypted-key-here',
  },
];

describe('planModel', () => {
  // ---------- 矩阵 #1 ----------
  it('#1: undefined → { inject: false }', () => {
    expect(planModel(undefined, P)).toEqual({ inject: false });
  });
  it('#1: "claude" → { inject: false }', () => {
    expect(planModel('claude', P)).toEqual({ inject: false });
  });

  // ---------- 矩阵 #2 ----------
  it('#2: "deepseek" → inject:true, default_model deepseek-chat', () => {
    const result = planModel('deepseek', P);
    expect(result).toEqual({
      inject: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat',
    });
  });
  it('#2: "glm" → inject:true, default_model glm-4.6', () => {
    const result = planModel('glm', P);
    expect(result).toEqual({
      inject: true,
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-4.6',
    });
  });

  // ---------- 矩阵 #3 ----------
  it('#3: 裸串命中迁移来的 provider name → inject:true', () => {
    const result = planModel('my-custom', P);
    expect(result).toEqual({
      inject: true,
      provider: 'my-custom',
      baseUrl: 'https://custom.example.com/anthropic',
      model: 'custom-model',
    });
  });

  // ---------- 矩阵 #4 ----------
  it('#4: "claude-opus-4-8" → 透传 { inject: false, model: "claude-opus-4-8" }', () => {
    expect(planModel('claude-opus-4-8', P)).toEqual({ inject: false, model: 'claude-opus-4-8' });
  });
  it('#4: "claude-sonnet-5" → 透传 { inject: false, model: "claude-sonnet-5" }', () => {
    expect(planModel('claude-sonnet-5', P)).toEqual({ inject: false, model: 'claude-sonnet-5' });
  });

  // ---------- 矩阵 #5 ----------
  it('#5: "deepseek/deepseek-reasoner" → inject:true, model 为 deepseek-reasoner', () => {
    const result = planModel('deepseek/deepseek-reasoner', P);
    expect(result).toEqual({
      inject: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-reasoner',
    });
  });
  it('#5: "anthropic/claude-opus-4-8" → inject:false（官方直连无 env）', () => {
    expect(planModel('anthropic/claude-opus-4-8', P)).toEqual({ inject: false, model: 'claude-opus-4-8' });
  });
  it('#5: "deepseek/未知model" → inject:true, model 透传（不阻塞）', () => {
    const result = planModel('deepseek/未知model', P);
    expect(result).toEqual({
      inject: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: '未知model',
    });
  });
  it('#5: "nope/x" → SpawnError(400) 且 message 含可用列表', () => {
    expect(() => planModel('nope/x', P)).toThrowError(/未知 provider "nope"/);
    // 注意：SpawnError 扩展 Error，vitest 的 toThrow 匹配 message
    try {
      planModel('nope/x', P);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('anthropic');
      expect(e.message).toContain('deepseek');
      expect(e.message).toContain('glm');
    }
  });

  // ---------- 边界 ----------
  it('自定义 provider baseUrl=null → inject:false 无 env', () => {
    const providers: ProviderSnapshot[] = [
      { name: 'official', baseUrl: null, models: ['m1'], defaultModel: null, apiKeyEnc: null },
    ];
    expect(planModel('official', providers)).toEqual({ inject: false });
  });
  it('自定义 provider baseUrl=null + defaultModel → inject:false 带 model', () => {
    const providers: ProviderSnapshot[] = [
      { name: 'official', baseUrl: null, models: ['m1'], defaultModel: 'm1', apiKeyEnc: null },
    ];
    expect(planModel('official', providers)).toEqual({ inject: false, model: 'm1' });
  });
  it('provider/model 但 provider 不存在 → SpawnError(400)', () => {
    expect(() => planModel('ghost/x', P)).toThrowError(/未知 provider "ghost"/);
  });
});

describe('buildInjectedEnv', () => {
  const deepseekPlan = { inject: true as const, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' };
  const glmPlan = { inject: true as const, provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6' };
  const customPlan = { inject: true as const, provider: 'my-custom', baseUrl: 'https://custom.example.com/anthropic', model: 'custom-model' };

  it('deepseek + key → env 正确', () => {
    const result = buildInjectedEnv(deepseekPlan, 'sk-test');
    expect(result).toEqual({
      model: 'deepseek-chat',
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-test' },
    });
  });
  it('deepseek 无 key → 抛 SpawnError 文案逐字匹配', () => {
    expect(() => buildInjectedEnv(deepseekPlan, undefined)).toThrowError(
      'deepseek API key 未配置（设置页绑定或 server 设 DEEPSEEK_API_KEY），无法使用 deepseek 别名',
    );
  });
  it('glm + key → env 正确', () => {
    const result = buildInjectedEnv(glmPlan, 'sk-glm');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-glm');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });
  it('glm 无 key → 抛 SpawnError 文案逐字匹配', () => {
    expect(() => buildInjectedEnv(glmPlan, undefined)).toThrowError(
      'glm API key 未配置（设置页绑定或 server 设 GLM_API_KEY），无法使用 glm 别名',
    );
  });
  it('自定义 provider 无 key → 通用文案', () => {
    expect(() => buildInjectedEnv(customPlan, undefined)).toThrowError(
      'provider "my-custom" 未配置 API key',
    );
  });
  it('key 存在 → 通用 env 结构', () => {
    const result = buildInjectedEnv(customPlan, 'sk-custom');
    expect(result).toEqual({
      model: 'custom-model',
      env: { ANTHROPIC_BASE_URL: 'https://custom.example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-custom' },
    });
  });
});
