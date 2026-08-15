#!/usr/bin/env bash
# =============================================================================
# dsh-plugin-wechat 一键安装 + 启动（唯一入口，可重复运行）
#
# 纯 DSH 单进程模式（无需 OpenClaw）：
#   1. 安装 DSH（如缺）         2. 安装本插件到 DSH（如缺）
#   3. 配置 DSH 模型路由        4. 启动 DSH web（微信通道随插件一并启动）
#   5. 微信扫码在 DSH 启动后由插件自动弹出
#
# 用法：
#   bash scripts/setup.sh              # 从仓库运行
#   bash scripts/setup.sh /path/to/repo   # 插件源码不在当前目录时指定
#   dsh-wechat-setup                   # npm 发布后：全局安装后直接运行
#   npx -y dsh-wechat-setup            # 或临时运行
#
# 之后日常使用：重跑本条命令即可（幂等）。
# 停止：pkill -f "dsh web"
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------- 路径与常量
# 解析 BASH_SOURCE 可能存在的符号链接（npm 全局/npx 安装时 bin 在 .bin/ 下是 symlink）
_SRC="${BASH_SOURCE[0]}"
while [ -L "${_SRC}" ]; do
  _DIR="$(cd -P "$(dirname "${_SRC}")" >/dev/null 2>&1 && pwd)"
  _LINK="$(readlink "${_SRC}")"
  case "${_LINK}" in
    /*) _SRC="${_LINK}" ;;
    *) _SRC="${_DIR}/${_LINK}" ;;
  esac
done
SCRIPT_DIR="$(cd -P "$(dirname "${_SRC}")" && pwd)"
REPO_DIR="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
LOG_DIR="${HOME}/.dsh-plugin-wechat/logs"
DSH_SETTINGS="${DSH_HOME:-$HOME/.dsh}/settings.yaml"
mkdir -p "${LOG_DIR}"

say()  { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
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

# ---------------------------------------------------------------- 0. 前置
command -v node >/dev/null 2>&1 || die "未找到 node。请先安装 Node.js >= 22：https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR:-0}" -ge 22 ] || warn "Node v${NODE_MAJOR} 偏旧，建议升级到 >= 22"
[ -f "${REPO_DIR}/package.json" ] || die "找不到插件仓库：${REPO_DIR}"

# ---------------------------------------------------------------- 1. DSH
if command -v dsh >/dev/null 2>&1; then
  say "DSH 已安装，跳过"
else
  say "安装 DSH（npm install -g @deepseek-ai/dsh）..."
  npm install -g @deepseek-ai/dsh || {
    warn "全局安装失败（可能需要管理员权限）。请手动执行：sudo npm install -g @deepseek-ai/dsh，然后重跑本脚本"
    exit 1
  }
fi
if ! command -v pnpm >/dev/null 2>&1; then
  say "安装 pnpm（npm install -g pnpm）..."
  npm install -g pnpm
fi

# ---------------------------------------------------------------- 2. 插件装入 DSH web profile
if grep -q 'dsh-plugin-wechat' "${PROFILE_DIR}/package.json" 2>/dev/null; then
  say "插件已装入 DSH web profile，跳过"
else
  say "构建插件并装入 DSH（dsh plugin --profile web add ${REPO_DIR}）..."
  if [ ! -f "${REPO_DIR}/dist/wechat.js" ] || { [ -d "${REPO_DIR}/src" ] && find "${REPO_DIR}/src" -newer "${REPO_DIR}/dist/wechat.js" | grep -q .; }; then
    (cd "${REPO_DIR}" && pnpm install --no-frozen-lockfile >/dev/null 2>&1 && pnpm build)
  fi
  dsh plugin --profile web add "${REPO_DIR}"
fi

# ---------------------------------------------------------------- 3. DSH 模型路由
if ! grep -q '^llm-deepseek:' "${DSH_SETTINGS}" 2>/dev/null; then
  say "配置 DSH 模型路由（settings.yaml 写入 llm-deepseek 段）..."
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    fs.mkdirSync(require("path").dirname(p), { recursive: true });
    let body = "";
    try { body = fs.readFileSync(p, "utf8"); } catch {}
    if (!body.trim().endsWith("\n")) body += "\n";
    body += "\n# DeepSeek 模型适配器（dsh-plugin-wechat 自动写入）\nllm-deepseek:\n  thinking: disabled\n  maxTokens: 4096\n";
    fs.writeFileSync(p, body);
  ' "${DSH_SETTINGS}"
fi
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  say "检测到 DeepSeek API Key —— 模型配置就绪"
  KEY_READY=1
elif [ -f "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml" ] && grep -q 'DEEPSEEK_API_KEY' "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml" 2>/dev/null; then
  say "检测到已保存的 DeepSeek API Key —— 模型配置就绪"
  KEY_READY=1
else
  warn "尚未配置 DeepSeek API Key —— 请打开 http://127.0.0.1:${DSH_WEB_PORT} 在「设置 → 模型」里填入（或 export DEEPSEEK_API_KEY=你的key 后重跑本脚本）"
fi

# ---------------------------------------------------------------- 4. 启动 DSH web（微信通道随插件启动）
if port_listening "${DSH_WEB_PORT}"; then
  say "DSH web 已在运行（http://127.0.0.1:${DSH_WEB_PORT}）"
else
  say "启动 DSH web → http://127.0.0.1:${DSH_WEB_PORT}（日志：${LOG_DIR}/dsh-web.log）"
  nohup dsh web --port "${DSH_WEB_PORT}" >"${LOG_DIR}/dsh-web.log" 2>&1 &
  say "等待 DSH 启动（微信通道随插件加载，首次会弹二维码）..."
  for i in $(seq 1 30); do
    if port_listening "${DSH_WEB_PORT}"; then
      say "DSH web 已就绪（http://127.0.0.1:${DSH_WEB_PORT}）"
      break
    fi
    sleep 2
  done
fi

# ---------------------------------------------------------------- 5. 收尾
if [ -n "${KEY_READY:-}" ]; then
  say "安装完成！DSH 内的微信通道已随插件启动（首次会弹二维码扫码，或用 DSH 网页操作）。"
else
  say "还剩一步：打开 http://127.0.0.1:${DSH_WEB_PORT} 填 DeepSeek API Key，然后微信通道即可工作。"
fi
say "日常启动/自愈：重跑本脚本即可（幂等）。停止：pkill -f \"dsh web\""
