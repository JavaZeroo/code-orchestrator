#!/bin/sh
# co-fetch-ms —— MindSpore wheel 三源拉取，落宿主缓存（design-machines-env ④）
# 用法:
#   co-fetch-ms <YYYYMMDD> [branch] [pyenv]   # 日包：默认 master py311
#   co-fetch-ms <commit-sha> [pyenv]          # 指定 commit：查编包平台，无则触发编包并等待
#   co-fetch-ms --resolve-only ...            # 只解析出下载 URL，不下载（调试用）
set -e
CACHE="${CO_CACHE_DIR:?CO_CACHE_DIR 未注入}/wheels/mindspore"
DAILY="${CO_MS_DAILY_BASE:-https://repo.mindspore.cn/mindspore/mindspore/version}"
BUILD="${CO_MS_BUILD_API:-}"
RESOLVE=0; [ "$1" = "--resolve-only" ] && { RESOLVE=1; shift; }
KEY="$1"; [ -n "$KEY" ] || { echo "用法: co-fetch-ms <YYYYMMDD|commit> [branch|pyenv] [pyenv]" >&2; exit 2; }

pytag() { echo "${1:-py311}" | sed 's/py/cp/'; }  # py311 -> cp311

if echo "$KEY" | grep -qE '^[0-9]{8}$'; then
  BRANCH="${2:-master}"; PY=$(pytag "${3:-py311}")
  MONTH=$(echo "$KEY" | cut -c1-6)
  DIR=$(curl -fsSL "$DAILY/$MONTH/$KEY/" | grep -oE "href=\"${BRANCH}_[^\"]+_newest/\"" | sed 's/href="//;s/"//' | tail -1)
  [ -n "$DIR" ] || { echo "[co-fetch-ms] $KEY 无 $BRANCH 日包" >&2; exit 1; }
  # 日包固定层级：<newest>/unified/<arch>/mindspore-*-<cpXX>-*.whl
  BASE="$DAILY/$MONTH/$KEY/${DIR}unified/$(uname -m)/"
  WHL=$(curl -fsSL "$BASE" | grep -oE 'href="[^"]*mindspore[^"]*\.whl"' | grep "$PY" | sed 's/href="//;s/"//' | head -1)
  [ -n "$WHL" ] || { echo "[co-fetch-ms] $BASE 下未找到 $PY 的 mindspore whl" >&2; exit 1; }
  case "$WHL" in http*) URL="$WHL";; /*) URL="https://repo.mindspore.cn$WHL";; *) URL="$BASE$WHL";; esac
else
  PY="${2:-py311}"
  [ -n "$BUILD" ] || { echo "[co-fetch-ms] 未配置编包平台（CO_MS_BUILD_API）" >&2; exit 1; }
  # 已有成功构建？（commit 前缀匹配 + python_env 匹配）
  FOUND=$(curl -fsS --noproxy "*" "$BUILD/builds?limit=100" | python3 -c "
import json,sys
key,py=sys.argv[1],sys.argv[2]
for b in json.load(sys.stdin):
    if b.get('status')=='success' and b.get('commit_sha','').startswith(key) and b.get('python_env')==py and b.get('artifacts') and not b.get('purged'):
        a=b['artifacts'][0]; print(b['id'], a['name']); break
" "$KEY" "$PY" || true)
  if [ -z "$FOUND" ]; then
    echo "[co-fetch-ms] 无现成构建，触发编包（约 2-5 分钟，ccache 加持）…" >&2
    ID=$(curl -fsS --noproxy "*" -X POST "$BUILD/builds" -H 'Content-Type: application/json' \
      -d "{\"ref\":\"$KEY\",\"python_env\":\"$PY\",\"backend\":\"ascend\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
    while :; do
      sleep 20
      ST=$(curl -fsS --noproxy "*" "$BUILD/builds?limit=100" | python3 -c "
import json,sys
bid=int(sys.argv[1])
for b in json.load(sys.stdin):
    if b['id']==bid:
        print(b['status'], (b['artifacts'][0]['name'] if b.get('artifacts') else '')); break
" "$ID")
      case "$ST" in
        success*) FOUND="$ID $(echo "$ST" | cut -d' ' -f2)"; break;;
        failed*|error*|cancelled*) echo "[co-fetch-ms] 编包失败: $ST（详见编包平台 build $ID）" >&2; exit 1;;
        *) echo "[co-fetch-ms] 编包中… ($ST)" >&2;;
      esac
    done
  fi
  BID=$(echo "$FOUND" | cut -d' ' -f1); NAME=$(echo "$FOUND" | cut -d' ' -f2)
  URL="$BUILD/builds/$BID/artifacts/$NAME"
fi

[ "$RESOLVE" = 1 ] && { echo "$URL"; exit 0; }
DEST="$CACHE/$KEY"
[ -n "$(ls "$DEST"/*.whl 2>/dev/null)" ] && { echo "[co-fetch-ms] 已缓存: $DEST"; exit 0; }
mkdir -p "$CACHE"
exec 9>"$CACHE/.$KEY.lock"; flock 9
[ -n "$(ls "$DEST"/*.whl 2>/dev/null)" ] && { echo "[co-fetch-ms] 已缓存(并发): $DEST"; exit 0; }
TMP="$CACHE/.$KEY.tmp"; rm -rf "$TMP"; mkdir -p "$TMP"
echo "[co-fetch-ms] 下载 $URL" >&2
case "$URL" in
  ${CO_MS_BUILD_API:-__none__}*) ( cd "$TMP" && curl -fSLO --noproxy '*' --retry 3 "$URL" );;
  *) ( cd "$TMP" && curl -fSLO --retry 3 "$URL" );;
esac
rm -rf "$DEST" && mv "$TMP" "$DEST"
echo "[co-fetch-ms] 就绪: $DEST/$(ls "$DEST")"
