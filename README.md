# code-orchestrator

> Multi-agent development orchestration platform — drive coding-agent sessions from
> the browser (multi-CLI × multi-model), build human-in-the-loop workflows by talking
> to an agent, and let the system run your project's **requirement → development →
> test** lifecycle across a fleet of machines, against a pluggable code-hosting backend.

[中文简介见下方](#中文简介) · License: Apache-2.0

---

## What it is

code-orchestrator is a self-hosted control plane for coding agents. It lets you:

- **Operate agent sessions from a web UI** — open a Claude Code (or other CLI) session
  on any registered machine, chat, approve tool calls remotely, watch rendered markdown
  and diffs, see token/cost, interrupt a turn.
- **Build workflows conversationally** — describe a process to a designer agent and it
  emits a workflow graph (React Flow) of agent / gate / meeting nodes; run it, and it
  pauses at human-approval gates for as long as needed.
- **Start work from an issue** — a requirement intake trigger watches forge issues and
  turns each one that matches a label/title filter into a workflow run automatically,
  with the issue's fields injected as variables.
- **Close the loop with your forge** — an agent opens a pull request, and the system
  polls CI gate status / review comments / conflicts and *nudges* the responsible
  session to fix them (semantics borrowed from agent-orchestrator's reaction model).
- **Cross-check with multiple models** — a meeting node fans out independent reviewers
  (e.g. two different models) and arbitrates by vote / model / human.

Decoupled along two axes: **CLI** (the executor — Claude Code, Codex, …) and **model**
(the brain — Claude, DeepSeek, GLM, … via Anthropic-compatible endpoints). The
code-hosting **forge** is a pluggable interface (gitcode today; github/gitlab planned).

## Architecture

```
        Browser (React + Vite + Tailwind)
   sessions · workflow graph · approvals · notifications
                    │ HTTP + WebSocket
        ┌───────────┴───────────────────────────┐
        │  Server (Fastify + Drizzle/Postgres)   │
        │  event log · workflow engine · forge   │
        │  poller · better-auth                  │
        └───┬───────────────────────┬────────────┘
            │ WS + JSON-RPC 2.0     │
     ┌──────┴─────┐          ┌──────┴─────┐        ┌──────────┐
     │ Runner @m1 │   ...    │ Runner @mN │        │  Forge   │
     │ Agent SDK  │          │ (NPU box)  │        │ (gitcode)│
     └────────────┘          └────────────┘        └──────────┘
```

Everything is **event-sourced**: session messages, tool calls, approvals, workflow
state transitions and forge signals are all events — powering live sync, workflow
recovery, and audit from one append-only log.

The **requirement → development → test** chain runs end-to-end through this picture:
the intake poller turns matching forge issues into workflow runs (requirement), the
engine drives agent sessions on runners (development), and the forge poller feeds CI
gate / review results back into the responsible session (test).

Packages (pnpm monorepo, TypeScript end-to-end):

| Package | Role |
|---|---|
| `packages/protocol` | Session wire protocol + JSON-RPC method tables + workflow schema (Zod) |
| `packages/server`   | Control plane: event log, WS hubs, workflow engine, forge integration, auth |
| `packages/runner`   | Per-machine daemon: drives agent CLIs, routes approvals |
| `packages/web`      | React front end |

## Requirement intake trigger

File an issue, get a running workflow — the entry point of the requirement →
development → test loop. A trigger binds a forge repo to a workflow definition; a
poller watches open issues (60s interval, forge-agnostic via the same pluggable
interface), and any issue matching the trigger's filter (required labels + title
regex) starts a run of the bound workflow, with `issue_*` variables injected
(`issue_number`, `issue_title`, `issue_body`, `issue_url`, `issue_author`) for agent
prompts to reference. Every (trigger, issue) hit is recorded exactly once — dedup
guarantees an issue never starts two runs, and each intake links to its run for
traceability. On first enable the poller only seeds a baseline of pre-existing
issues without starting runs, unless backfill is explicitly turned on.

## Quick start (development)

Requirements: Node 22+, pnpm 11+, a Postgres 16 instance.

```bash
pnpm install

# configure the server
cp packages/server/.env.example packages/server/.env
#   set DATABASE_URL, AUTH_SECRET (openssl rand -hex 32), RUNNER_SHARED_TOKEN, PUBLIC_URL

# apply schema (dev) and build the web bundle the server will serve
pnpm --filter @co/server exec drizzle-kit push
pnpm --filter @co/web build

# run (default server port 7620)
pnpm dev:server
pnpm dev:runner   # one per execution machine; set SERVER_URL / MACHINE_LABELS
```

Open `http://<server-host>:7620`, register, and (optionally) bind a forge token in
Settings to enable PR/issue features under your own identity.

## Deployment

Three supported shapes — pm2 (process manager), Docker Compose, and a script for
constrained hosts (old Docker, no compose). See [`deploy/README.md`](deploy/README.md).

## Model access

`claude` runs via the Anthropic Agent SDK directly. Aliases `deepseek` / `glm` inject
their Anthropic-compatible endpoints (`ANTHROPIC_BASE_URL` + key) — configure keys in
the server environment. Any CLI × any model.

## Status

Working end-to-end: sessions, tool approvals, conversational workflow authoring, the
workflow engine (agent / gate / meeting nodes), multi-model review meetings, requirement
intake triggers (issue → workflow run), and forge gate feedback (verified against real
pull requests). The web UI, auth, and pluggable forge are actively evolving. Not yet
production-hardened — no automated test suite yet, single forge implementation
(gitcode), and remote execution assumes trusted machines.

## Attribution

Vendors code from [slopus/happy](https://github.com/slopus/happy) (MIT) — the session
wire protocol and the re-implemented Claude/Codex driver semantics. See [`NOTICE`](NOTICE)
and the in-tree `VENDOR.md` / `VENDOR_PLAN.md` notes. Reaction-model and worktree
patterns are informed by [AgentWrapper/agent-orchestrator](https://github.com/AgentWrapper/agent-orchestrator)
(Apache-2.0, design only, no code copied).

Licensed under Apache-2.0 — see [`LICENSE`](LICENSE).

---

## 中文简介

**code-orchestrator** 是一个自托管的多 agent 开发编排平台:在网页上操控编码 agent
会话(多 CLI × 多模型)、通过对话搭建 human-in-the-loop 工作流、用一套系统管理项目的
「需求 → 开发 → 测试」全流程,代码托管后端可插拔。

核心能力:网页开会话/远程审批工具调用/看 markdown 与 diff/成本追踪;对话式生成工作流图
(agent/gate/meeting 节点);需求录入触发器(issue 命中过滤条件自动起工作流);agent 提 PR
后自动轮询门禁并把评审意见/失败回流给负责会话;多模型交叉评审会议。CLI(执行器)与模型
(大脑)两轴解耦,forge(代码托管)可插拔。

### 需求录入触发器

提一个 issue,起一条工作流——「需求 → 开发 → 测试」链路的入口。触发器把 forge 仓库
绑定到一个工作流定义:轮询器(60s 一轮,forge 无关)监视 open issue,命中过滤条件
(标签全含 + 标题正则)的 issue 自动启动绑定的工作流,并注入 issue_* 变量(编号/标题/
正文/链接/作者)供 agent 提示词引用。每个 (触发器, issue) 命中只记录一次——去重保证
同一 issue 不会重复起 run,每条录入可追溯到对应 run。首次启用只对存量 issue 建立基线
(登记不触发),显式打开 backfill 才会回灌历史。

架构、部署、快速开始见上方英文章节与 `deploy/README.md`、`docs/design.md`。
