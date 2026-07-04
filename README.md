# code-orchestrator

多 agent 开发编排系统：网页操控 agent 会话（多 CLI × 多模型）、对话式搭建工作流（human-in-the-loop）、NPU 机群执行、gitcode.com 集成。完整设计见 [docs/design.md](docs/design.md)。

## 布局

```
packages/
├── protocol/   # 统一会话消息协议（vendor 自 happy-wire）+ JSON-RPC + workflow schema
├── server/     # 控制面：Fastify + WS + Drizzle(Postgres)，含编排引擎与 gitcode 集成
├── runner/     # 机器侧 daemon：注册机器、驱动 agent CLI、回传协议事件
└── web/        # React 前端：会话对话页、工作流图（React Flow）、审批中心
```

## 开发

```bash
pnpm install
pnpm typecheck

# Postgres：开发环境已部署在宿主机 192.168.9.186 的 co-postgres 容器（--net=host），
# 连接串见 packages/server/.env（不入库）。其他环境可用 docker compose up -d postgres。

cp packages/server/.env.example packages/server/.env   # 补上 DATABASE_URL
pnpm --filter @co/web build   # server 会托管 dist（开发热更也可用 pnpm --filter @co/web dev）
pnpm dev:server               # 默认 0.0.0.0:7620（8080 被宿主机服务占用）
pnpm dev:runner               # 每台执行机各跑一个；SERVER_URL=ws://<server>:7620/ws/runner

# 浏览器访问 http://192.168.9.186:7620（容器为 host 网络）
```

## Vendor 说明

`packages/*/src/vendor/**` 下的代码复制自 [slopus/happy](https://github.com/slopus/happy)（MIT），
锁定 commit `d2ef88deffa337546f0c477f28385d470188cb38`，此后由本仓库独立维护。
各 vendor 目录内附 `LICENSE.happy` 与 `VENDOR.md`（来源、取舍、修改记录）。
