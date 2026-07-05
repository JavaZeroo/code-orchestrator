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

Packages (pnpm monorepo, TypeScript end-to-end):

| Package | Role |
|---|---|
| `packages/protocol` | Session wire protocol + JSON-RPC method tables + workflow schema (Zod) |
| `packages/server`   | Control plane: event log, WS hubs, workflow engine, forge integration, auth |
| `packages/runner`   | Per-machine daemon: drives agent CLIs, routes approvals |
| `packages/web`      | React front end |

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
workflow engine (agent / gate / meeting nodes), multi-model review meetings, and forge
gate feedback (verified against real pull requests). The web UI, auth, and pluggable
forge are actively evolving. Not yet production-hardened — no automated test suite yet,
single forge implementation (gitcode), and remote execution assumes trusted machines.

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
(agent/gate/meeting 节点);agent 提 PR 后自动轮询门禁并把评审意见/失败回流给负责会话;
多模型交叉评审会议。CLI(执行器)与模型(大脑)两轴解耦,forge(代码托管)可插拔。

架构、部署、快速开始见上方英文章节与 `deploy/README.md`、`docs/design.md`。
