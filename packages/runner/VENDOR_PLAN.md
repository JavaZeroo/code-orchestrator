# runner 的 happy-cli 抽取清单（任务：Claude 驱动接入）

来源：slopus/happy @ `d2ef88deffa337546f0c477f28385d470188cb38`，`packages/happy-cli/src/`。
本地克隆可用（scratchpad），抽取时同样带 LICENSE.happy + 出处头注释。

## M1 抽取（Claude 驱动）

> **结果（2026-07-03）**：驱动最终对公开 SDK API **重写**于 `src/claude/`（driver.ts + mapper.ts，~400 行），
> 语义（streaming 输入队列、init/result 状态机、审批挂起/决议、CLAUDE_CODE_ENTRYPOINT 处理）对齐下表文件，代码未搬运——
> happy 的实现耦合其 api/session/logger 体系，重写比抽取更少代码。已实测：对话、多轮、工具审批（含 updatedInput 改写）、kill。
> 下表保留作为语义出处索引；M2 的 codex 客户端仍按原计划原样搬运。

| happy-cli 路径 | 用途 | 改造 |
|---|---|---|
| `claude/sdk/**`（query.ts、types.ts） | Claude Agent SDK 薄封装 | 基本原样；依赖 `@anthropic-ai/claude-agent-sdk`（happy 用 ^0.3.179） |
| `claude/claudeRemote.ts` | remote 模式驱动循环（SDK query → 消息流） | 输出改为映射到 protocol envelope 后经 `session.event` 上报 |
| `claude/utils/permissionHandler.ts` | canUseTool 挂起/决议的 pending map | 审批请求改发 `approval.request` RPC；决议从 `approval.decide` 进入 |
| `agent/adapters/MessageAdapter.ts`（参考） | 原生输出 → envelope 映射 | happy 生产走 legacy 格式，映射需对齐我们采纳的 sessionProtocol，预计手写 100–200 行 |

## M2+ 抽取

- `codex/codexAppServerClient.ts` + `codexAppServerTypes.ts` — Codex app-server JSON-RPC 客户端（审批/fork/resume/中断），原样保留
- `agent/core/AgentBackend.ts` — 多后端统一抽象（M1 直用 claude 驱动，抽象在接第二个 CLI 时引入）
- `modules/{ripgrep,difftastic,watcher}` — 按 web 端 diff/搜索需求引入

## 缝合面（happy 侧被替换的部分）

- `api/api.ts`、`api/apiSession.ts`（socket.io 同步 + E2E 加密）→ 本包 `src/connection.ts`（WS + JSON-RPC，明文）
- `api/encryption.ts` → 删除
- daemon 注册/RPC（`daemon/**`）→ 本包 `src/index.ts` + `src/methods.ts` 已承担
- happy 的 logger/configuration → 本包轻量实现

## 驱动接入后的验证清单

1. `session.spawn` → SDK 会话拉起 → envelope 事件流回传 server
2. 工具调用 → `approval.request` → server 决议 → `approval.decide` → SDK 放行
3. `env` 注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 指向 deepseek（`api.deepseek.com/anthropic`）与 glm（`open.bigmodel.cn/api/anthropic`），跑通对话与工具调用（M1 首要验证假设）
4. `session.send` 多轮、`session.kill` 清理、断线重连后会话存活性
