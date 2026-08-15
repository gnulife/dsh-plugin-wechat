#!/usr/bin/env bash
# =============================================================================
# dsh-plugin-wechat macOS launchd 服务管理（可选）
#
# 将 DSH web（含微信通道）注册为开机自启 + 崩溃自动重启的 LaunchAgent。
# 适用于不想在终端前台常驻 DSH 的场景。
#
# 用法:
#   bash scripts/service.sh install   # 安装并启动 DSH 开机自启服务
#   bash scripts/service.sh start     # 启动
#   bash scripts/service.sh stop      # 停止
#   bash scripts/service.sh status    # 查看状态
#   bash scripts/service.sh uninstall # 卸载服务（恢复手动前台跑）
#
# 注意: 首次登录仍需终端扫码（node scripts/login.js）。凭证持久化后即可无缝切换后台。
# =============================================================================
set -euo pipefail

LABEL="ai.dsh.web"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DSH_BIN="$(command -v dsh || echo "$HOME/.nvm/versions/node/v24.12.0/bin/dsh")"
LOG_DIR="$HOME/.dsh-plugin-wechat/logs"
mkdir -p "$LOG_DIR"

say()  { printf '\033[1;32m[service]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v launchctl >/dev/null 2>&1 || die "launchctl 不可用（仅 macOS）"

write_plist() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WECHAT_MODE</key>
        <string>native</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>${DSH_BIN}</string>
        <string>web</string>
        <string>--port</string>
        <string>3080</string>
    </array>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/dsh-web.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/dsh-web.err.log</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  install)
    write_plist
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
    say "已安装并启动开机自启服务 ${LABEL}"
    ;;
  start)
    launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl start "$LABEL"
    say "已启动 ${LABEL}"
    ;;
  stop)
    launchctl kill SIGTERM "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl stop "$LABEL"
    say "已停止 ${LABEL}"
    ;;
  status)
    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | head -20 || echo "服务未加载"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload -w "$PLIST"
    rm -f "$PLIST"
    say "已卸载 ${LABEL}，恢复手动前台跑"
    ;;
  *)
    echo "用法: $0 {install|start|stop|status|uninstall}"
    exit 1
    ;;
esac
