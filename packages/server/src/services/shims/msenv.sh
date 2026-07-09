#!/bin/sh
# msenv —— 容器内 MindSpore venv 多版本并存与秒切（design-machines-env ⑤）
# 用法: msenv <key>（key 与 co-fetch-ms 一致）; msenv list; msenv current
set -e
ENVS=/opt/co-envs
CACHE="${CO_CACHE_DIR:?CO_CACHE_DIR 未注入}/wheels/mindspore"
case "${1:-}" in
  ""|-h|--help) echo "用法: msenv <key> | list | current"; exit 2;;
  list) ls "$ENVS" 2>/dev/null | grep '^ms-' | sed 's/^ms-//'; exit 0;;
  current) readlink "$ENVS/current" 2>/dev/null | sed 's#.*/ms-##' || echo "(未激活)"; exit 0;;
esac
KEY="$1"; VENV="$ENVS/ms-$KEY"
if [ ! -x "$VENV/bin/python" ]; then
  WHL=$(ls "$CACHE/$KEY"/*.whl 2>/dev/null | head -1)
  [ -n "$WHL" ] || { echo "[msenv] 缓存无 $KEY 的 wheel——先 co-fetch-ms $KEY" >&2; exit 1; }
  echo "[msenv] 建 venv $VENV（继承系统 site-packages）…" >&2
  mkdir -p "$ENVS"
  python3 -m venv --system-site-packages "$VENV"
  "$VENV/bin/pip" install --no-index --find-links="$CACHE/$KEY" --force-reinstall --no-deps "$WHL" >/dev/null
fi
ln -sfn "$VENV" "$ENVS/current"
echo "[msenv] 已切到 $KEY（新起的 shell 生效；当前 shell 需 . $ENVS/current/bin/activate）"
"$ENVS/current/bin/python" -c "import mindspore; print('mindspore', mindspore.__version__)" 2>/dev/null || true
