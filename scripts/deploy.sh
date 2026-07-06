#!/bin/bash
# 自我修改安全:健康门部署 + 自动回滚(grill-me 共识 #5)。
# 独立于 co-server 运行(auto-merge 应 detached 地 spawn 它,使其能在 co-server 重启期间存活)。
# 流程:记回滚点 → pull → 预检(install+typecheck+test)→ 拒绝含迁移的自动部署(迁移是护栏路径)
#       → rebuild web → 重启 co-server → 探活;不健康则自动 git reset 回滚 + 重启老代码。
# 退出码:0=部署成功 1=预检失败已回滚 2=部署后不健康已回滚 3=回滚也失败(需人工) 4=前置错误
set -uo pipefail
export PATH="/root/.nvm/versions/node/v24.15.0/bin:$PATH"
ROOT="/data/ljb/projects/code-orchestrator"
HEALTH="http://127.0.0.1:7620/health"
cd "$ROOT" || exit 4

log() { echo "[deploy $(date +%H:%M:%S)] $*"; }
health_ok() { curl -sf --noproxy '*' --max-time 4 "$HEALTH" >/dev/null 2>&1; }
wait_health() { for _ in $(seq 1 "${1:-15}"); do health_ok && return 0; sleep 2; done; return 1; }

# 干净树才敢部署(不覆盖未提交改动)
if [ -n "$(git status --porcelain)" ]; then log "工作树不干净，拒绝部署"; exit 4; fi
BEFORE=$(git rev-parse HEAD)
log "回滚点 $BEFORE"

rollback() {
  log "⏪ 回滚 → $BEFORE"
  git reset --hard "$BEFORE" --quiet
  pnpm --filter @co/web build >/dev/null 2>&1
  pm2 restart co-server >/dev/null 2>&1
  if wait_health 15; then log "已回滚，co-server 健康"; exit "${1:-2}"; fi
  log "❌ 回滚后仍不健康 —— 需人工介入"; exit 3
}

git fetch origin --quiet || { log "fetch 失败"; exit 4; }
git reset --hard origin/main --quiet
AFTER=$(git rev-parse HEAD)
log "部署 $BEFORE → $AFTER"

# 护栏:含新迁移的变更不走自动部署(迁移风险高，交人工)
if [ "$BEFORE" != "$AFTER" ] && git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^packages/server/drizzle/.*\.sql$'; then
  log "检测到迁移文件变更 —— 自动部署拒绝(迁移交人工)"; git reset --hard "$BEFORE" --quiet; exit 4
fi

# 预检:装依赖 + typecheck + test
log "预检: install"; pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 || { log "install 失败"; rollback 1; }
log "预检: typecheck"; pnpm -r typecheck >/dev/null 2>&1 || { log "❌ typecheck 失败 — 不部署"; rollback 1; }
log "预检: test"; pnpm -r test >/dev/null 2>&1 || { log "❌ test 失败 — 不部署"; rollback 1; }

# rebuild web + 重启 + 健康门
log "rebuild web"; pnpm --filter @co/web build >/dev/null 2>&1
log "重启 co-server"; pm2 restart co-server >/dev/null 2>&1
if wait_health 15; then log "✅ 部署成功 $AFTER，co-server 健康"; exit 0; fi
log "co-server 重启后不健康"; rollback 2
