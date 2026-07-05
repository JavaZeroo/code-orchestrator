#!/usr/bin/env bash
# 镜像获取（宿主机无外网直连），按 registry 自动选路：
#   docker.io  → 宿主机直连 hub.rat.dev 拉取（多架构、layer 缓存断点续传），重试 + 架构校验后打回原名
#   其他(ghcr.io 等) → 开发容器内 skopeo 走代理拉 tar → scp → 宿主机 docker load
# 实测连通性（2026-07-03）：容器代理只通 ghcr.io；宿主机直连只通 hub.rat.dev / SWR（后者 amd64 单架构，勿用）。
# 用法: scripts/pull-image.sh <image[:tag]> [arch]     # arch 默认 arm64
# 例:   scripts/pull-image.sh postgres:16-alpine
#       scripts/pull-image.sh ghcr.io/coder/code-server:latest
set -euo pipefail

IMAGE="${1:?用法: pull-image.sh <image[:tag]> [arch]}"
ARCH="${2:-arm64}"
HOST="${IMAGE_LOAD_HOST:?设置 IMAGE_LOAD_HOST=user@host 指向目标宿主机}"

# 归一化：确定 registry 与仓库路径
REF="$IMAGE"
if [[ "$REF" != */* ]]; then
  REF="docker.io/library/$REF"
else
  FIRST="${REF%%/*}"
  if [[ "$FIRST" != *.* && "$FIRST" != *:* && "$FIRST" != localhost ]]; then
    REF="docker.io/$REF"
  fi
fi
[[ "$REF" == *:* ]] || REF="$REF:latest"
REGISTRY="${REF%%/*}"
REPO_TAG="${REF#*/}"                 # 去掉 registry 的 repo:tag
LOAD_TAG="$IMAGE"
[[ "$LOAD_TAG" == *:* ]] || LOAD_TAG="$LOAD_TAG:latest"

if [[ "$REGISTRY" == "docker.io" ]]; then
  echo "==> 路线A：宿主机经 hub.rat.dev 拉取 $REPO_TAG (linux/$ARCH)"
  ssh -o BatchMode=yes "$HOST" "
    set -e
    for i in 1 2 3 4 5; do
      echo \"-- attempt \$i\"
      timeout 500 docker pull hub.rat.dev/$REPO_TAG && break
    done
    A=\$(docker inspect -f '{{.Architecture}}' hub.rat.dev/$REPO_TAG)
    [ \"\$A\" = \"$ARCH\" ] || { echo \"架构不符: \$A != $ARCH\"; exit 1; }
    docker tag hub.rat.dev/$REPO_TAG $LOAD_TAG
    echo loaded: $LOAD_TAG \(\$A\)
  "
else
  echo "==> 路线B：容器内 skopeo 经代理拉取 $REF (linux/$ARCH)"
  SAFE=$(echo "$LOAD_TAG" | tr '/:' '__')
  WORK=$(mktemp -d /root/.image-pull.XXXXXX)   # 本地盘，勿用 NFS
  trap 'rm -rf "$WORK"' EXIT
  TAR="$WORK/$SAFE.tar"
  skopeo copy --override-os linux --override-arch "$ARCH" \
    "docker://$REF" "docker-archive:$TAR:$LOAD_TAG"
  echo "==> scp → $HOST"
  scp -q "$TAR" "$HOST:/tmp/$SAFE.tar"
  echo "==> docker load @ $HOST"
  ssh -o BatchMode=yes "$HOST" "docker load -i /tmp/$SAFE.tar && rm -f /tmp/$SAFE.tar"
fi

echo "==> done: $LOAD_TAG (linux/$ARCH) 已就绪于宿主机"
