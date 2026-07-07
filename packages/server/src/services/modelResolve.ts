/**
 * #61 M1：model 解析纯函数核。
 *
 * 职责：alias → ModelPlan（零 DB / 零 env / 零 async，便于单测）。
 * 薄异步壳在 spawn.ts 的 resolveModel 中——该函数聚合并注入 key。
 *
 * 兼容矩阵（5 种 legacy 形态）：
 *   1. undefined / 'claude' → { inject: false }
 *   2. 'deepseek' / 'glm'   → { inject: true, provider, baseUrl, model: default_model }
 *   3. 裸串命中 providers.name（含迁移来的旧 endpoint label）→ 同上
 *   4. 其余裸串（如 claude-opus-4-8）→ { inject: false, model: alias } 透传
 *   5. provider/model 新格式 → 拆解查表
 */

// ---------- 类型 ----------

export class SpawnError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderSnapshot {
  name: string;
  baseUrl: string | null;
  models: string[];
  defaultModel: string | null;
  apiKeyEnc: string | null; // 仅 shell 用，纯函数不读
}

export type ModelPlan =
  | { inject: false; model?: string }                                  // 空 / 透传 / 官方直连
  | { inject: true; provider: string; baseUrl: string; model?: string }; // 需注入 key

// ---------- 纯函数核 ----------

/**
 * 纯：alias → ModelPlan。未知 provider（仅 provider/model 形态）直接抛 SpawnError(400)。
 */
export function planModel(alias: string | undefined, providers: ProviderSnapshot[]): ModelPlan {
  // 矩阵 #1：undefined / 'claude' → 空
  if (!alias || alias === 'claude') {
    return { inject: false };
  }

  // 矩阵 #5：含 '/' → 新格式 provider/model
  const slashIdx = alias.indexOf('/');
  if (slashIdx !== -1) {
    const providerName = alias.slice(0, slashIdx);
    const model = alias.slice(slashIdx + 1) || undefined;
    const prov = providers.find((p) => p.name === providerName);
    if (!prov) {
      const available = providers.map((p) => p.name).join(', ');
      throw new SpawnError(
        400,
        `未知 provider "${providerName}"，可用：${available}`,
      );
    }
    // model 不在 models 内也透传（不阻塞）
    if (prov.baseUrl === null) {
      return { inject: false, model };
    }
    return { inject: true, provider: prov.name, baseUrl: prov.baseUrl, model };
  }

  // 矩阵 #2/#3：裸串命中 providers.name
  const prov = providers.find((p) => p.name === alias);
  if (prov) {
    const model = prov.defaultModel ?? undefined;
    if (prov.baseUrl === null) {
      // 官方直连，无需 env
      return { inject: false, model };
    }
    return { inject: true, provider: prov.name, baseUrl: prov.baseUrl, model };
  }

  // 矩阵 #4：其余裸串透传
  return { inject: false, model: alias };
}

/**
 * 纯：注入分支 + 已解析 key → env；key 缺失抛 400（deepseek/glm 逐字保留原文案，其余通用文案）。
 */
export function buildInjectedEnv(
  plan: Extract<ModelPlan, { inject: true }>,
  key: string | undefined,
): { model?: string; env: Record<string, string> } {
  if (!key) {
    if (plan.provider === 'deepseek') {
      throw new SpawnError(
        400,
        'deepseek API key 未配置（设置页绑定或 server 设 DEEPSEEK_API_KEY），无法使用 deepseek 别名',
      );
    }
    if (plan.provider === 'glm') {
      throw new SpawnError(
        400,
        'glm API key 未配置（设置页绑定或 server 设 GLM_API_KEY），无法使用 glm 别名',
      );
    }
    throw new SpawnError(400, `provider "${plan.provider}" 未配置 API key`);
  }
  return {
    model: plan.model,
    env: { ANTHROPIC_BASE_URL: plan.baseUrl, ANTHROPIC_AUTH_TOKEN: key },
  };
}
