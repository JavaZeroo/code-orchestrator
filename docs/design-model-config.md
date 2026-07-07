# 模型配置重构：Provider → Model 两级模型体系

版本：2026-07-07
状态：规划定稿（用户点名：设置界面简陋、模型名需 provider → model 逻辑），两期实现
关系：替代 llm_endpoints 的「label → 单模型」扁平注册表；设置页模型区与全部模型选择器随之重构。

---

## 0. 诊断

- `llm_endpoints` 一行 = 一个 label 绑一个 model：同一 provider 挂 N 个模型要重复填 N 遍 baseUrl+key；
- UI 里的「模型名」实为端点 label，无 provider 概念；内置 claude/deepseek/glm 三别名硬编码在 `resolveModel`（spawn.ts:56）与前端；
- 设置界面是 Auth.tsx 里的长 modal：forge token、per-user LLM key（枚举死 deepseek/glm）、自定义端点表单平铺堆叠；
- 工作流 def 里已存在裸模型名（`claude-opus-4-8`、`claude-sonnet-5`、`deepseek`）——**resolveModel 是 dogfood 流水线命脉，任何改动必须全向后兼容**。

## 1. 数据模型

新表 `llm_providers`（迁移 0012，additive；旧表 `llm_endpoints`/`llm_keys` 保留不删）：

| 列 | 说明 |
|---|---|
| id, name(unique) | name 为 slug（anthropic/deepseek/glm/自定义…） |
| base_url | Anthropic 兼容端点；**null = 官方直连（宿主凭据）** |
| api_key_enc | 加密；null = 回落 per-user llm_keys（deepseek/glm）→ 环境变量 |
| models jsonb | string[]，该 provider 可用模型名，用户自维护 |
| default_model | 裸引用该 provider 时用 |
| created_by, created_at, updated_at | 所有权同 endpoints（全局可见、owner 可改） |

**迁移内置 seed**：`anthropic`（base_url null，models 含 claude-opus-4-8/claude-sonnet-5 等，default 空=宿主默认）、`deepseek`（api.deepseek.com/anthropic，[deepseek-chat, deepseek-reasoner]，default deepseek-chat）、`glm`（open.bigmodel.cn/api/anthropic，[glm-4.6]）。
**数据迁移**：`llm_endpoints` 每行 → 一个 provider（name=label, models=[model], default_model=model）；冲突跳过。

## 2. 统一模型引用格式

一律 `provider/model` 字符串（如 `deepseek/deepseek-chat`）——**协议零改动**（session.model / node.model 本就是 string）。

`resolveModel` v2 解析顺序（**每条都要单测**，这是自举安全线）：
1. 含 `/` → 拆 provider+model → 查表注入 env（key 缺失且 provider∈{deepseek,glm} → per-user llm_keys → 环境变量，沿用现逻辑）；
2. 裸 `claude` → 现行为不变（无 env、无 model）；
3. 裸 `deepseek` / `glm` / 其他命中 providers.name（含迁移来的旧 label）→ 该 provider 的 default_model + env；
4. 其余裸字符串 → 原样透传 model（现行为；流水线 def 的 `claude-opus-4-8`/`claude-sonnet-5` 靠这条）。

## 3. API 与 UI

- **M1（server）**：`/api/llm/providers` CRUD（GET 列表含 models/default/hasKey，PUT :name 增改，DELETE :name；内置三 provider 可改配置不可删）。旧 `/api/llm/endpoints` 保留只读兼容，M2 后下线。
- **M2（web）**：
  - 设置页模型区重构：provider 卡片列表（名称/端点/key 状态/模型 chips/默认标记），卡片内联增删模型、改默认、换 key；「新增 Provider」表单；
  - Composer 模型 chip 两级化：Radix Select 分组（provider 为组头、models 为项），值=`provider/model`；
  - LlmKeyRow（per-user key）归并进对应 provider 卡片的「我的 key」栏；
  - designer / 受理 agent 的 system prompt 中模型提示改为新格式（旧别名仍可用）。

## 4. 分期与部署

- **M1** server：迁移 0012 + seed + 数据迁移 + resolveModel v2（vitest 单测覆盖全部 legacy 形态）+ providers CRUD。含迁移 → 人工 apply + 部署；部署后流水线（用旧别名）照跑即为回归验证。
- **M2** web：等 M1 部署后发车（依赖新 API）。纯 web，全自动。
