#!/usr/bin/env bash
# 宿主机（docker 18.09、无 compose、无外网）部署脚本。
# 前提：镜像已在本机（构建见 deploy/README.md：开发容器 podman 构建 → save → docker load，
#       或任意有网机器 docker build → save → scp）。
# 用法：POSTGRES_PASSWORD=... AUTH_SECRET=... RUNNER_SHARED_TOKEN=... ./run-host.sh
set -euo pipefail

: "${POSTGRES_PASSWORD:?需要 POSTGRES_PASSWORD}"
: "${AUTH_SECRET:?需要 AUTH_SECRET（openssl rand -hex 32）}"
: "${RUNNER_SHARED_TOKEN:?需要 RUNNER_SHARED_TOKEN}"
PUBLIC_URL="${PUBLIC_URL:-http://$(hostname -I | awk '{print $1}'):7620}"

# 宿主机 ipv4 forwarding 关闭 → 一律 host 网络
docker rm -f co-postgres co-server 2>/dev/null || true

docker run -d --name co-postgres --restart unless-stopped --net=host \
  -e POSTGRES_USER=co -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB=co \
  -v co-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine

echo "等待 postgres 就绪…"
for i in $(seq 1 30); do
  docker exec co-postgres pg_isready -U co >/dev/null 2>&1 && break
  sleep 2
done

docker run -d --name co-server --restart unless-stopped --net=host \
  -e DATABASE_URL="postgres://co:${POSTGRES_PASSWORD}@127.0.0.1:5432/co" \
  -e RUNNER_SHARED_TOKEN="$RUNNER_SHARED_TOKEN" \
  -e AUTH_SECRET="$AUTH_SECRET" \
  -e PUBLIC_URL="$PUBLIC_URL" \
  -e RUN_MIGRATIONS=1 -e PORT=7620 \
  co-server:latest

echo "server → ${PUBLIC_URL}"
echo "runner 在各执行机上另行部署（pm2 或 co-runner 镜像），SERVER_URL=ws://<本机IP>:7620/ws/runner"
