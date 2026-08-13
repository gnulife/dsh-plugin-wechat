#!/usr/bin/env bash
# =============================================================================
# dsh-plugin-wechat 日常一键启动
#
# 同时拉起两个进程（重复运行安全，已在跑的不会被重复启动）：
#   1) DSH web        —— 微信机器人的大脑，插件桥端口 8787
#   2) OpenClaw 网关  —— 微信通道（扫码登录/收发消息）
#
# 用法：
#   bash scripts/start.sh
#   DSH_WEB_PORT=3000 bash scripts/start.sh        # 自定义 DSH web 端口
#   OPENCLAW_GATEWAY_PORT=20000 bash scripts/start.sh  # 自定义网关端口
#
# 停止：pkill -f "dsh web"; pkill -f "openclaw gateway"
# 日志：$HOME/.dsh-plugin-wechat/logs/
# =============================================================================
set -euo pipefail

DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"
DSH_BRIDGE_PORT="${DSH_BRIDGE_PORT:-8787}"
OC_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LOG_DIR="${HOME}/.dsh-plugin-wechat/logs"
mkdir -p "${LOG_DIR}"

say()  { printf '\033[1;32m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
  else
    return 1
  fi
}

command -v dsh >/dev/null 2>&1 || die "未找到 dsh，先安装：npm install -g @deepseek-ai/dsh"
command -v openclaw >/dev/null 2>&1 || die "未找到 openclaw，先运行：bash scripts/setup.sh"

# ---------------------------------------------------------------- 1. DSH web
if port_listening "${DSH_WEB_PORT}"; then
  say "DSH web 已在运行 → http://127.0.0.1:${DSH_WEB_PORT}"
else
  say "启动 DSH web → http://127.0.0.1:${DSH_WEB_PORT}（日志：${LOG_DIR}/dsh-web.log）"
  WECHAT_PORT="${DSH_BRIDGE_PORT}" nohup dsh web --port "${DSH_WEB_PORT}" >"${LOG_DIR}/dsh-web.log" 2>&1 &
fi

# ---------------------------------------------------------------- 2. OpenClaw 网关
if port_listening "${OC_PORT}"; then
  say "OpenClaw 网关已在运行 → ws://127.0.0.1:${OC_PORT}"
else
  if ! node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const p = path.join(os.homedir(), ".openclaw", "openclaw.json");
    let mode;
    try { mode = JSON.parse(fs.readFileSync(p, "utf8"))?.gateway?.mode; } catch {}
    process.exit(mode === "local" ? 0 : 1);
  '; then
    warn "~/.openclaw/openclaw.json 缺少 gateway.mode=local，网关可能拒绝启动。"
    warn "请先运行：bash scripts/setup.sh（会自动补上）"
  fi
  say "启动 OpenClaw 网关（日志：${LOG_DIR}/openclaw-gateway.log）"
  nohup openclaw gateway >"${LOG_DIR}/openclaw-gateway.log" 2>&1 &
fi

say "完成。用微信给机器人发消息即可。"
say "状态检查：openclaw status；桥检查：curl -s http://127.0.0.1:${DSH_BRIDGE_PORT}/v1/models"
