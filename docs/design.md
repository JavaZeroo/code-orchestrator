# code-orchestrator 设计文档

版本：v0.1（2026-07-03）
状态：讨论定稿，待实现验证

## 1. 目标与非目标

**目标**：自建一套多 agent 开发编排系统，管理 mindformers（昇腾生态，托管于 gitcode.com）的全流程开发：

- 网页上开启/操控/审批 agent 会话（类 happy 的远程操控体验，web-only）
- 对话式搭建工作流：跟 meta-agent 说需求，生成可视化工作流图（节点 = 不同角色/模型/CLI 的 agent 任务），图上可点击查看、可编辑
- 完整 loop engine：需求录入 → 分析 → 拆解 → 方案设计 → 实现 → PR → 门禁/评审回流，全程 human-in-the-loop
- 多 CLI（claude code / codex / opencode）× 多模型（claude / deepseek / glm / chatgpt）完全解耦
- 多模型会议：多个模型对同一 PR 独立评审 + 仲裁达成一致
- 角色系统：SE（评审）、PL（需求进展管理）等领域身份
- 执行层覆盖十几台 NPU 服务器（单机为主，多机分布式复用现有 msrun 脚本）

**非目标（现阶段）**：移动 App、端到端加密、多租户/对外服务、自研分布式训练调度、通用 SaaS 化。

## 2. 总体架构

```
┌─────────────────────────── Web (React + Vite) ───────────────────────────┐
│  会话对话页(协议事件渲染+审批按钮)  工作流图(React Flow)  审批中心  diff/编辑  │
└────────────────────────────────┬──────────────────────────────────────────┘
                          HTTP + WebSocket/SSE
┌────────────────────────────────┴──────────────────────────────────────────┐
│                       Server（控制面，单进程起步）                          │
│  ├─ API/实时通道（Fastify + WS）        ├─ 事件日志（append-only，系统地基） │
│  ├─ 会话/机器注册表                     ├─ 审批路由（ApprovalRequest 归一）  │
│  ├─ Orchestrator 模块：工作流状态机 + meta-agent + 会议节点 + nudge 规则     │
│  ├─ forge-gitcode：/api/v5 客户端 + webhook/轮询                            │
│  └─ 通知出口（Web 内 + 钉钉/企微/飞书 webhook）                              │
└──────┬──────────────────┬──────────────────┬───────────────────────────────┘
       │ WS(runner协议)    │                  │            ┌────────────────┐
┌──────┴─────┐     ┌──────┴─────┐     ┌──────┴─────┐       │  gitcode.com   │
│ Runner@NPU1 │     │ Runner@NPU2 │ … │ Runner@NPUn │       │ (webhook/轮询) │
│ agent驱动层 │     │            │     │            │       └────────────────┘
│ worktree    │     │            │     │            │
└─────────────┘     └────────────┘     └────────────┘
```

设计基石：**事件溯源**。会话消息、工具调用、审批请求与决议、工作流状态迁移、gitcode 门禁结果，全部是事件日志里的事件。多端同步 = 订阅 + 补拉；工作流恢复 = 状态重建；审计/全链路 trace = 事件投影。（该模式源自 agent-orchestrator 的 SQLite CDC + SSE 验证过的实践。）

## 3. 仓库形态与组件职责

pnpm monorepo，TypeScript 端到端：

| 包 | 职责 | 来源 |
|---|---|---|
| `packages/protocol` | 统一会话消息协议、workflow JSON schema、API/事件类型（Zod） | 基座 vendor 自 happy-wire（~360 行），扩展审批/工作流/机器类型 |
| `packages/runner` | 机器侧 daemon：注册机器 → 接收 spawn/resume RPC → 驱动 agent CLI → 回传协议事件；附带 bash/文件 RPC、worktree 准备 | 核心 vendor 自 happy-cli（见 §4），传输层重写 |
| `packages/server` | 控制面（含 orchestrator 模块与 forge-gitcode，起步单进程） | 自写，结构参考 happy-server |
| `packages/web` | React + Vite 前端 | 自写；消息渲染逻辑 vendor happy-app 的 reducer |

## 4. 复用地图（happy → 本项目）

happy 为 MIT 许可，vendor 时保留版权声明（各 vendored 目录放 `LICENSE.happy` + 来源注记）。采用**复制固化**而非依赖其 npm 包：我们要改内部实现且不追上游。

| happy 源路径 | 落到 | 改造点 |
|---|---|---|
| `packages/happy-wire/src/sessionProtocol.ts` | protocol | 原样为主；扩展 `ApprovalRequest`、workflow 事件 |
| `happy-cli/src/agent/**`（AgentBackend、MessageAdapter、factories） | runner | 保留抽象；AgentId 先留 claude，codex/opencode 后开 |
| `happy-cli/src/claude/sdk/**` + `claudeRemote.ts` + `utils/permissionHandler.ts` | runner | Agent SDK 驱动照用；`canUseTool` 挂起 → 发 ApprovalRequest 事件到我们 server，决议回流放行 |
| `happy-cli/src/codex/codexAppServerClient.ts` + types | runner | 原样保留（自己重写成本高），M2 后启用 |
| `happy-cli/src/daemon/**`（controlServer、spawnSession/resumeSession） | runner | 保留 RPC 语义；机器注册与传输改接我们 server 的 WS |
| `happy-cli/src/modules/**`（ripgrep、difftastic、watcher、bash/file RPC） | runner | 基本原样；worktree 准备走 bash RPC，不写新 daemon 代码 |
| `happy-cli/src/api/**`（encryption、api、apiSession） | —— | **不要**。E2E 与 happy-server 同步整体替换为明文 WS + token |
| `happy-app/sources/sync/reducer/**`（messageToEvent、reducer） | web | 纯 TS 可移植；作为会话时间线渲染的数据层 |
| `happy-server`（Fastify+socket.io+Prisma、per-account seq、RPC relay） | —— | 只作结构参考，自写（去 E2E、加简单 token auth） |
| `happy-app` 其余（84k 行 RN）、`codium`、加密模块 | —— | 不用 |

## 5. 从 agent-orchestrator 借鉴的设计（搬模式不搬代码）

调研结论（2026-07-03，源码级）：不适合做底座——UI 仅 Electron 私有协议加载、daemon 只绑 127.0.0.1 无 auth（明文写为设计红线）；会话是 tmux PTY 透传（"The terminal IS the conversation"），无结构化消息与审批 UI；零远程执行概念；无声明式工作流引擎。但以下设计值得照抄语义：

1. **反馈 nudge**（`lifecycle/reactions.go`）：CI 失败/评审意见/合并冲突 → 生成去重、封顶（3 次）的文本 nudge，路由给负责该任务的 agent 会话 → M3 门禁回流的参考答案
2. **自动 review 循环**（`review/`）：新 commit → reviewer agent 基于 worktree 评审 → `changes_requested` 作为 nudge 回流
3. **worktree-per-session 纪律**（`adapters/workspace/gitworktree`）：并行 agent 互不踩踏
4. **SQLite CDC → SSE** 的事件管道形态

## 6. 数据模型（草案）

```
User           id, name, email（better-auth 管理），gitcode_token（服务端密钥加密存储）
Machine        id, name, labels(npu/卡数), status, last_active_at
Session        id, machine_id, agent_cli, model, role, cwd, status, native_session_id,
               workflow_node_id?, created_by
Event          seq(全局), session_id?, run_id?, type, payload(json), created_at   ← append-only
ApprovalRequest id, session_id|node_id, kind(tool|gate), payload, status, decided_by, decided_at
WorkflowDef    id, name, version, graph(json, 见 §7), created_via(chat|manual)
WorkflowRun    id, def_id, status, context(json), started_at
NodeState      run_id, node_id, status(pending|running|waiting_human|done|failed), session_id?, output(json)
MeetingRecord  run_id, node_id, participants(json), rounds(json), verdict, minutes_md
Role           id(SE/PL/dev…), system_prompt, tool_whitelist, default_model, memory_dir
ForgeRef       pr/issue 编号 ↔ run/node 映射, ci_status
```

事件类型（首批）：`session.message`（协议消息封套）、`session.state`、`approval.requested/decided`、`run.node.state`、`forge.ci`、`forge.review_comment`、`nudge.sent`、`notify.sent`。

## 7. Workflow Schema 与对话式搭建

```jsonc
{
  "name": "需求分析流程",
  "nodes": [
    { "id": "analyze", "type": "agent",
      "role": "SE", "cli": "claude", "model": "claude|deepseek|glm",
      "machine": { "labels": ["npu"] },        // 机器选择器
      "prompt": "分析需求 {{issue_url}}，产出需求分析文档",
      "outputs": ["docs/analysis.md"] },
    { "id": "confirm", "type": "gate", "approvers": ["me"], "on_timeout": "notify" },
    { "id": "review", "type": "meeting",
      "participants": [ {"model":"deepseek"}, {"model":"glm"} ],
      "rounds": 2, "arbiter": {"model":"claude"} },
    { "id": "impl", "type": "agent", "role": "dev", "..." : "..." }
  ],
  "edges": [["analyze","confirm"],["confirm","review"],["review","impl"]]
}
```

节点类型：`agent` | `gate`（human 审批/选择，可挂起数天） | `meeting`（独立评审 N 份 → 交换反驳 → 仲裁 → 纪要落 MeetingRecord） | `fanout` | `condition`。

**对话式搭建** = 一条 meta-agent 会话（走同一 runner 通道）+ 唯一工具 `emit_workflow(json)`：工具层做 schema 校验（不合法自动重试），前端把每次 emit 实时渲染成 React Flow 草图，用户确认后存为 WorkflowDef。图上手工编辑后可序列化回 JSON 让 meta-agent 继续改。

**引擎**：自写薄状态机（预估 300–500 行核心）。调度循环消费事件推进 NodeState；`gate` = 停在 `waiting_human` 直到 `approval.decided`；崩溃恢复 = 从 NodeState + 事件日志重建。不引入 Temporal/LangGraph。

## 8. 关键链路

1. **开会话**：web/引擎 → server 校验 → 目标 runner 收 spawn RPC（含 role 的 system prompt、模型端点、cwd/worktree）→ Agent SDK 驱动 → 协议事件回传 → 事件表 + WS 广播
2. **审批**：driver `canUseTool` 挂起 → `approval.requested` → web 审批中心 + IM webhook 通知 → 决议 → runner 放行。工具审批与 workflow gate 走同一套 ApprovalRequest
3. **门禁回流**：**轮询为主**（调研结论：gitcode webhook 仅 push/tag/issue/PR/评论 5 类事件，无 CI 事件，也无 commit status API；门禁状态只能轮询 PR 标签 `ci-pipeline-passed` 与 `mergeable_state`）→ `forge.ci`/`forge.review_comment` 事件 → nudge 规则（去重/封顶）→ 定位负责节点的会话 → 注入修复指令。webhook 保留用于 issue/PR/评论类事件（签名 `X-GitCode-Signature-256`）
4. **会议**：fanout 评审会话（各模型独立出具 结论+理由+评分 的结构化意见）→ 可选反驳轮 → 仲裁（模型/规则/人）→ 纪要 + 结论事件

## 9. 模型接入矩阵

| 模型 | 路径 | 状态 |
|---|---|---|
| claude | Agent SDK 直连 | 主力开发节点 |
| deepseek | `api.deepseek.com/anthropic`（官方 Anthropic 兼容端点，经 env base URL 注入 Claude 驱动） | **M1 首要验证项** |
| glm | `open.bigmodel.cn/api/anthropic` 同上 | 同上 |
| chatgpt | codex 驱动（vendored app-server client） | M2 后启用 |

风险注记：deepseek/glm 跑复杂 agentic 任务对工具协议遵循度打折 → 优先用于评审/会议类节点；主力实现节点用 claude。

## 10. NPU 执行

- 每台 NPU 机跑一个 runner，注册到 server（labels 标注卡型/卡数）；机器清单先静态配置
- worktree 准备经 runner 的 bash RPC（`git worktree add`），不新增 daemon 代码
- 多机分布式：**不自研调度**，agent 节点调用现有 msrun/启动脚本（agent 做人做的事）
- 卡占用记账 M1 不做，先靠 labels + 人工避让

## 11. 里程碑

- **M1 · 垂直切片** ✅（2026-07-03 验收）：protocol + server（事件表/WS/审批）+ runner（Claude 驱动）+ web 会话页。已验证：浏览器开会话、对话多轮、远程审批（含 updatedInput 改参）；deepseek/glm 透传实现完成、实测待 API keys（搁置）
- **M2 · 编排** ✅（2026-07-03 验收）：引擎（agent/gate 节点、模板替换、跨节点数据流转、gate 挂起恢复、boot 恢复）+ React Flow 运行视图 + designer 会话对话生成（emit_workflow in-process MCP 工具，字符串输入容错）。已验证：三节点工作流全链路 e2e（gate 审批 + 工具审批），对话生成合法草图
- **M3 · 闭环** ✅（2026-07-04 验收）：forge-gitcode 客户端（Bearer+UA+418/429 退避+节流+PR ensure 语义，匿名读 mindformers 真实 PR 实测通过）+ 轮询器（30s：PR 标签门禁/mergeable/评论增量 → forge.* 事件 → nudge 去重封顶3次，merged PR 自动停跟实测通过）+ agent 输出 PR URL 自动登记 + 会议节点（fan-out 独立评审→vote/human/模型仲裁→纪要落库，2 参与者投票 e2e 155s 通过；评审姿态=只读白名单+禁 Bash/Write）+ code-server（容器内 7621，machineInfo.codeServerUrl 深链）。附带修复：runner 重启后的孤儿会话 reconcile（注册时判死 + decide 惰性回收）。**注**：nudge 注入活会话的完整链路等首个真实 token+PR 场景验证（发送通道与 session.send 同路径，已被反复验证）

## 12. 已决策（2026-07-03 拍板）

1. **存储：直接 Postgres**（docker-compose 提供开发实例），ORM 用 Drizzle（TS-first、无 codegen 服务、better-auth 有一等适配器）
2. **auth：better-auth**（MIT 开源、TS 全栈方案），email/password 起步。系统引入 User 概念——**每个用户配置自己的 gitcode token**，PR/评论以个人身份发出。✅ 已落地（2026-07-04）：/api/auth/* 挂载、全 API preHandler 鉴权、/ws/client 会话校验、user_settings 表存 AES-256-GCM 加密 token（录入即 GET /user 验证并绑定 gitcode login）、forge 调用按"请求者本人 → 任一绑定用户 → GITCODE_TOKEN env"解析、审计字段（createdBy/decidedBy）取自登录身份
3. **gitcode：已调研**，报告见 `docs/research/gitcode-api.md`。要点：API 为 Gitee v5 风格（`api.gitcode.com/api/v5`）；PR/issue/行级评审评论齐全；限流 400/分、4000/时，另有 418 WAF；**无 CI webhook 事件、无 commit status API**（门禁靠轮询 PR 标签）；mindformers 位于 `mindspore/mindformers`，合并门禁 = CI 标签 + approved + 2×lgtm。per-user token 落地：PATCH 后 re-GET 校验
4. **vendor 策略：锁定 happy master 当前 commit**（记录于各 VENDOR 注记），此后自行维护，不追上游；重大修复手工 cherry-pick
5. **runner↔server 协议：纯 WebSocket + JSON-RPC 2.0**（不沿用 socket.io），双向：server→runner（spawn/kill/bash），runner→server（事件上报/审批请求）
6. NPU 卡资源记账：暂缓（M2 后再议）
