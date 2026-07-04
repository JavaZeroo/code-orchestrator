# 部署指南

三种形态，按环境选择：

## A. 开发容器（当前生产形态）：pm2

无 systemd 的容器内用 pm2 托管三个服务（server / runner / code-server）：

```bash
pnpm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save            # 快照进程列表
pm2 ls / pm2 logs   # 状态与日志（日志在 .pm2-logs/）
# 容器重启后恢复：pm2 resurrect
```

配置来源：server 读 `packages/server/.env`（DATABASE_URL / AUTH_SECRET / RUNNER_SHARED_TOKEN / PUBLIC_URL）；
runner 的环境在 `ecosystem.config.cjs` 中；code-server 配置在 `~/.config/code-server/config.yaml`。

## B. 标准 Docker 环境：compose

要求 docker compose v2（或 docker-compose ≥1.27）：

```bash
cd deploy
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 12)
AUTH_SECRET=$(openssl rand -hex 32)
RUNNER_SHARED_TOKEN=$(openssl rand -hex 12)
CODE_SERVER_PASSWORD=$(openssl rand -hex 8)
PUBLIC_URL=http://<对外IP>:7620
EOF
docker compose up -d            # server + postgres + code-server
docker compose --profile runner up -d   # 本机也跑一个 runner（可选）
```

代理环境构建：compose 已透传 `http_proxy/https_proxy` build-arg。

## C. 受限宿主机（docker 18.09、无 compose、无外网）：run-host.sh

1. **镜像获取**（宿主机无法直接构建）：
   - 有网机器：`docker build -f deploy/Dockerfile.server -t co-server:latest . && docker save co-server:latest | gzip > co-server.tgz`，scp 到宿主机 `docker load`
   - 或开发容器内 podman 构建（走代理）后 save/load，同 `scripts/pull-image.sh` 的通道
2. **运行**：

```bash
POSTGRES_PASSWORD=... AUTH_SECRET=... RUNNER_SHARED_TOKEN=... deploy/run-host.sh
```

脚本使用 `--net=host`（该宿主机 ipv4 forwarding 关闭，桥接不可用）。

## 数据库迁移

- 正式部署：镜像内 `RUN_MIGRATIONS=1`，server 启动时自动应用 `packages/server/drizzle/` 迁移（幂等）
- 开发：沿用 `pnpm --filter @co/server db:push`（schema 直推），此时保持 `RUN_MIGRATIONS=0`
- **存量库基线**：由 push 演进而来的现有库首次切换到迁移体系时，需手工把 `drizzle/meta/_journal.json` 中的迁移标记为已应用（或接受 0000 init 在空库重放）。新库无此问题。

## runner 扩容（NPU 机群）

每台执行机（含 NPU 机器）任选其一：
- **裸机 pm2**（推荐，NPU 任务需要宿主环境）：clone 仓库 → `pnpm install` → 参照 ecosystem.config.cjs 起 co-runner，`SERVER_URL=ws://<server>:7620/ws/runner MACHINE_LABELS=npu,910b`
- **容器**：`co-runner:latest` 镜像 + 挂载 `~/.claude`（或传 ANTHROPIC_API_KEY）

注意每台机器都需要能访问 Anthropic API（直连或代理）与 gitcode。
