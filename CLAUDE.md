# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

code-orchestrator：自托管的多 agent 开发编排平台——网页操控编码 agent 会话（多 CLI × 多模型）、对话式搭建 human-in-the-loop 工作流、issue → 开发 → 测试全链路自动化，forge（代码托管）可插拔（现有 gitcode）。pnpm monorepo，全栈 TypeScript ESM。设计文档：`docs/design.md`（M1 主线 + 已决策清单）与 `docs/design-v2.md`（v2：项目一等化 + 容器化执行 + 资源调度，当前活跃开发方向，含十一条 grill 决议）。

## 常用命令

```bash
pnpm install                      # NFS 相关配置已固化在 pnpm-workspace.yaml，见下方陷阱
pnpm typecheck                    # 全包 tsc --noEmit
pnpm test                         # 全包 vitest（--passWithNoTests）
pnpm --filter @co/server test     # 单包测试
pnpm --filter @co/server exec vitest run src/services/scheduler.test.ts   # 单个测试文件
pnpm dev:server                   # Fastify 服务端，默认 :7620，读 packages/server/.env
pnpm dev:runner                   # 本机 runner（环境变量 SERVER_URL / MACHINE_LABELS）
pnpm --filter @co/web dev         # Vite 前端开发（代理 /api、/ws → 127.0.0.1:7620）
pnpm --filter @co/web build       # 构建产物由 server 静态托管
pnpm --filter @co/server db:push  # 开发环境 schema 直推（此时保持 RUN_MIGRATIONS=0）
```

无构建步骤：server/runner 用 tsx 直接跑 TS，`@co/protocol` 直接 export `.ts` 源。没有 lint 配置，只有 typecheck。

服务端配置从 `packages/server/.env.example` 复制为 `.env`：DATABASE_URL、AUTH_SECRET、RUNNER_SHARED_TOKEN、PUBLIC_URL。未配 AUTH_SECRET/DATABASE_URL 时 API 无鉴权运行（仅开发骨架）。

部署三形态（pm2 = 当前生产形态 `ecosystem.config.cjs`、docker compose、受限宿主机脚本）见 `deploy/README.md`。

## 数据库迁移纪律

- 开发用 `db:push` 直推；正式部署 `RUN_MIGRATIONS=1`，启动时自动应用 `packages/server/drizzle/` 下的迁移。
- **drizzle journal 与存量库不同步**：新表/新列一律手写 additive SQL 放入 `packages/server/drizzle/`，**不要跑 `drizzle-kit generate`**（会重列存量表）。保持全部 additive，不破坏在跑的 co 实例。

## 架构

四个包，靠 `@co/protocol`（workspace 依赖）连接：

- **protocol** — 协议单一事实源：runner↔server 的 JSON-RPC 2.0 方法表（`src/rpc.ts`，双向各一张表，params/result 全部 Zod 校验，接收方校验后分发）、会话线协议（`src/vendor/happy-wire/`，vendored 自 slopus/happy，MIT——改动须保留 VENDOR.md 注记与 NOTICE 归属）、workflow schema（agent/gate/meeting 节点）。
- **server** — 控制面（Fastify + Drizzle/Postgres + better-auth）。核心机制是**事件溯源**：`src/events.ts` 的进程内 bus + append-only events 表，会话消息、工具审批、工作流状态迁移、forge 信号全部作为事件走这条总线，支撑 WS 实时同步、断点恢复（`resumeActiveRuns`）与审计。两个 WS hub：`ws/clientHub.ts`（浏览器）与 `ws/runnerHub.ts`（runner 机群）。`engine/engine.ts` 是工作流引擎；`forge/` 是可插拔 forge 抽象（types + registry，adapters/ 现有 gitcode；poller 把 CI 门禁/评审/冲突回流 nudge 给负责会话，intake 把命中过滤器的 issue 变成工作流 run，含去重与基线）。`services/` 承载 v2：materialize（项目按机物化）、scheduler（黏性 + 溢出调度）、taskQueue（无资源排队）、spawnContainer（会话容器化执行链路）。
- **runner** — 每台执行机的守护进程：WS 连 server、注册机器信息（含 dataRoot、加速器 resources），经 Claude Agent SDK 驱动会话（`claude/driver.ts` + `mapper.ts` 做 SDK↔线协议映射）。容器执行（v2）：`container.ts` 封装 docker run/exec/rm，卡在建容器时绑定、容器销毁即释放；`container-agent/` 打包成自包含 agent.mjs（宿主暂存 `/opt/co-runtime`，只读挂进容器 `/opt/co`），在训练容器内跑 SDK 循环，stdin/stdout JSON-lines 由 host runner 桥回既有 uplink。
- **web** — React 19 + Vite + Tailwind 4 + React Flow（工作流图）+ TanStack Query。

模型接入两轴解耦：CLI（执行器：Claude Code、Codex…）× 模型（大脑）。`claude` 走 Agent SDK 直连；`deepseek`/`glm` 别名注入 Anthropic 兼容端点（ANTHROPIC_BASE_URL + key，配在 server 环境）。

v2 数据流（`docs/design-v2.md`）：项目 = Postgres 为真相的一等逻辑实体，按机器就地物化到 `<DATA_ROOT>/co/`（`base/` 项目检出、`cache/` 组件版本缓存、`wt/` 会话 worktree）；会话在 co 拥有的容器里执行；依赖经项目自带 `/workspace/.co/activate.sh` 按版本激活（co 注入 `CO_COMPONENTS`、`CO_DATA_ROOT`，co 核心零领域代码）；agent memory 是后端原生文件（如 `CLAUDE.md`、`~/.claude/.../memory`），由 co 经中心 bare git 仓跨机同步。

## 环境与陷阱

- `/data` 是 NFS：pnpm store 必须在本地盘（`/root/.pnpm-store`）+ hoisted 布局，已固化在 `pnpm-workspace.yaml`——pnpm 11 只认这个文件（.npmrc / package.json#pnpm 均无效），别改回去。
- 端口用 7620（8080 被宿主已有服务占用）。本机 curl 回环地址需加 `--noproxy '*'`。
- 主开发容器内没有 docker CLI，容器操作依赖宿主 docker，且宿主 docker 是多方共享的——**清理容器只用精确名字，或叠加 ancestor 镜像过滤；严禁宽泛 name 过滤器批量 rm**（曾误删 co-postgres）。
