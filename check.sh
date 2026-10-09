#!/usr/bin/env bash
# ============================================================
#  STI Harness 部署自检（Linux / macOS）
#  Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
#
#  只做自检，不监听端口；服务已在运行时也可以安全执行。
#  输出为纯文本，可整段复制发给管理员。
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[x] 未找到 Node.js。"
  echo "    请安装 Node.js 22.13 或更高版本：https://nodejs.org"
  echo ""
  exit 1
fi

VER=""
[ -f VERSION ] && VER="$(tr -d ' \r\n' < VERSION)"

echo "STI Harness version: ${VER}"
node app/main.mjs --check
RC=$?

echo ""
echo "------------------ end of report ------------------"
echo "复制以上全部内容发给管理员。"
exit $RC
