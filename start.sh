#!/usr/bin/env bash
# ============================================================
#  STI Harness 启动器（Linux / macOS）
#  Copyright 2026 liwei（易智瑞西安）.
#
#  与 start.cmd 等价。Node 版本门禁由 app/main.mjs 内部再次执行，
#  这里的检查只是为了更早、更友好地报错。
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[x] 未找到 Node.js。"
  echo "    请安装 Node.js 22.13 或更高版本：https://nodejs.org"
  echo "    （node:sqlite 自 22.13 起无需实验性开关即可使用。）"
  echo ""
  exit 1
fi

NEED_MAJOR=22
NEED_MINOR=13
CUR="$(node -p 'process.versions.node')"
CUR_MAJOR="${CUR%%.*}"
CUR_REST="${CUR#*.}"
CUR_MINOR="${CUR_REST%%.*}"
if [ "$CUR_MAJOR" -lt "$NEED_MAJOR" ] || { [ "$CUR_MAJOR" -eq "$NEED_MAJOR" ] && [ "$CUR_MINOR" -lt "$NEED_MINOR" ]; }; then
  echo ""
  echo "[x] Node.js 版本过低：当前 $CUR，需要 >= $NEED_MAJOR.$NEED_MINOR"
  echo "    请从 https://nodejs.org 安装 LTS 版本后重试。"
  echo ""
  exit 1
fi

VER=""
[ -f VERSION ] && VER="$(tr -d ' \r\n' < VERSION)"

PORT="${STI_PORT:-3090}"

echo ""
echo "Starting STI Harness ${VER} ...  (Ctrl+C to stop)"
echo "  Then open in browser:  http://127.0.0.1:${PORT}"
echo "  (port from STI_PORT if you set it, otherwise 3090)"
echo "  Do NOT open public/index.html directly."
echo ""

exec node app/main.mjs "$@"
