#!/usr/bin/env bash
# =============================================================================
# dsh-plugin-wechat 一键安装 + 启动（唯一入口，可重复运行）
#
# 自动完成：
#   1. 安装 DSH（如缺）      2. 安装本插件到 DSH（如缺）
#   3. 安装 OpenClaw + 微信通道插件（如缺）
#   4. 微信扫码登录（仅首次；已登录自动跳过）
#   5. 配置 OpenClaw 模型指向 DSH 桥
#   6. 启动 DSH web + OpenClaw 网关（已在跑则不重复启动）
#   7. 自检桥端点并给出完成提示
#
# 用法：
#   bash scripts/setup.sh              # 从仓库运行
#   bash scripts/setup.sh /path/to/repo   # 插件源码不在当前目录时指定
#   dsh-wechat-setup                   # npm 发布后：全局安装 dsh-plugin-wechat 直接运行
#   npx -y dsh-wechat-setup            # 或临时运行，不安装
#   OPENCLAW_GATEWAY_PORT=20000 bash scripts/setup.sh   # 自定义网关端口
#
# 之后日常使用：还是这一条命令（幂等，只会把没跑起来的拉起来）。
# 停止：pkill -f "dsh web"; pkill -f "openclaw gateway"
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------- 路径与常量
# 解析 BASH_SOURCE 可能存在的符号链接（npm 全局/npx 安装时 bin 在 .bin/ 下是 symlink），
# 得到脚本真实路径后，向上取包根目录。
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
OC_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
DSH_BRIDGE_PORT="${DSH_BRIDGE_PORT:-8787}"
DSH_BRIDGE_BASE="http://127.0.0.1:${DSH_BRIDGE_PORT}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
WX_ACCOUNTS="${STATE_DIR}/openclaw-weixin/accounts.json"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
LOG_DIR="${HOME}/.dsh-plugin-wechat/logs"
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
# dsh plugin 依赖 pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  say "安装 pnpm（npm install -g pnpm）..."
  npm install -g pnpm
fi

# ---------------------------------------------------------------- 2. 插件装入 DSH web profile
if grep -q 'dsh-plugin-wechat' "${PROFILE_DIR}/package.json" 2>/dev/null; then
  say "插件已装入 DSH web profile，跳过"
else
  say "构建插件并装入 DSH（dsh plugin --profile web add ${REPO_DIR}）..."
  # 源码比 dist 新（或 dist 缺失）时重新构建；npm 包内无 src 目录则跳过
  if [ ! -f "${REPO_DIR}/dist/wechat.js" ] || { [ -d "${REPO_DIR}/src" ] && find "${REPO_DIR}/src" -newer "${REPO_DIR}/dist/wechat.js" | grep -q .; }; then
    (cd "${REPO_DIR}" && pnpm install --no-frozen-lockfile >/dev/null 2>&1 && pnpm build)
  fi
  dsh plugin --profile web add "${REPO_DIR}"
fi

# DSH 模型配置：写入 llm-deepseek 段（无则激活模型路由），并检查 API Key
DSH_SETTINGS="${DSH_HOME:-$HOME/.dsh}/settings.yaml"
if ! grep -q '^llm-deepseek:' "${DSH_SETTINGS}" 2>/dev/null; then
  say "配置 DSH 模型路由（settings.yaml 写入 llm-deepseek 段）..."
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    fs.mkdirSync(require("path").dirname(p), { recursive: true });
    let body = "";
    try { body = fs.readFileSync(p, "utf8"); } catch {}
    if (!body.trim().endsWith("\n")) body += "\n";
    body += "\n# DeepSeek 模型适配器（dsh-plugin-wechat 自动写入）\nllm-deepseek:\n  thinking: enabled\n  reasoningEffort: high\n  maxTokens: 8192\n";
    fs.writeFileSync(p, body);
  ' "${DSH_SETTINGS}"
fi
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  say "检测到环境变量 DEEPSEEK_API_KEY —— 模型配置就绪"
  KEY_READY=1
elif [ -f "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml" ] && grep -q 'DEEPSEEK_API_KEY' "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml" 2>/dev/null; then
  say "检测到已保存的 DEEPSEEK_API_KEY —— 模型配置就绪"
  KEY_READY=1
else
  warn "尚未配置 DeepSeek API Key —— 请打开 http://127.0.0.1:${DSH_WEB_PORT} 在「设置 → 模型」里填入（或 export DEEPSEEK_API_KEY=你的key 后重跑本脚本）"
fi

# ---------------------------------------------------------------- 3. OpenClaw + 微信通道插件
if command -v openclaw >/dev/null 2>&1; then
  say "OpenClaw 已安装，跳过"
else
  say "安装 OpenClaw（npm install -g openclaw）..."
  npm install -g openclaw || {
    warn "全局安装失败（可能需要管理员权限）。请手动执行：sudo npm install -g openclaw，然后重跑本脚本"
    exit 1
  }
fi
if openclaw plugins list 2>/dev/null | grep -q "openclaw-weixin"; then
  say "微信通道插件已安装，跳过"
else
  say "安装微信通道插件 @tencent-weixin/openclaw-weixin ..."
  openclaw plugins install "@tencent-weixin/openclaw-weixin"
  openclaw config set plugins.entries.openclaw-weixin.enabled true
  openclaw config set gateway.mode local
fi

# ---------------------------------------------------------------- 4. 微信扫码登录（仅首次）
if [ -s "${WX_ACCOUNTS}" ]; then
  say "微信已登录过（${WX_ACCOUNTS}），跳过扫码"
else
  say "请用【微信小号】扫描终端里出现的二维码并确认（仅此一次）。"
  openclaw channels login --channel openclaw-weixin
fi

# ---------------------------------------------------------------- 5. 配置模型指向 DSH 桥
say "配置 OpenClaw 模型 Provider 指向 ${DSH_BRIDGE_BASE}/v1 ..."
# 两个关键坑（已踩过）：
# 1) 自定义 provider 必须一次性写入完整结构(baseUrl+api+models)，openclaw config set 单字段会校验失败；
# 2) baseUrl 必须带 /v1 后缀——openclaw 会把它原样拼上 /chat/completions，
#    不带 /v1 会请求到 /chat/completions 而桥只服务 /v1/chat/completions → 404。
PROVIDER_CHANGED="$(node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const p = path.join(process.env.OPENCLAW_STATE_DIR || os.homedir() + "/.openclaw", "openclaw.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  const baseUrl = process.argv[1];
  const apiKey = process.argv[2];
  const before = JSON.stringify(cfg.models?.providers?.dsh ?? null);
  cfg.models = cfg.models ?? {};
  cfg.models.providers = cfg.models.providers ?? {};
  cfg.models.providers.dsh = {
    ...(cfg.models.providers.dsh ?? {}),
    baseUrl,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: cfg.models.providers.dsh?.models ?? [
      { id: "dsh-agent", name: "DSH Agent", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 }
    ],
  };
  cfg.agents = cfg.agents ?? {};
  cfg.agents.defaults = cfg.agents.defaults ?? {};
  cfg.agents.defaults.model = cfg.agents.defaults.model ?? { primary: "dsh/dsh-agent" };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  process.stdout.write(before === JSON.stringify(cfg.models.providers.dsh) ? "unchanged" : "changed");
' "${DSH_BRIDGE_BASE}/v1" "${WECHAT_BRIDGE_API_KEY:-}")"

# provider 配置不会热加载——改了配置且网关在跑时，重启网关使其生效
if [ "${PROVIDER_CHANGED}" = "changed" ] && port_listening "${OC_PORT}"; then
  warn "OpenClaw 模型配置已更新，正在重启网关使其生效..."
  pkill -f "openclaw gateway" 2>/dev/null || true
  sleep 3
fi

# ---------------------------------------------------------------- 6. 启动
if port_listening "${OC_PORT}"; then
  say "OpenClaw 网关已在运行，跳过"
else
  say "启动 OpenClaw 网关（日志：${LOG_DIR}/openclaw-gateway.log）"
  nohup openclaw gateway >"${LOG_DIR}/openclaw-gateway.log" 2>&1 &
fi
if port_listening "${DSH_WEB_PORT}"; then
  if port_listening "${DSH_BRIDGE_PORT}"; then
    say "DSH web 已在运行且桥已就绪（http://127.0.0.1:${DSH_WEB_PORT}）"
  else
    warn "DSH web 已在运行但桥未就绪 —— 请手动重启一次让插件生效（Ctrl-C 后重跑本脚本）"
  fi
else
  say "启动 DSH web → http://127.0.0.1:${DSH_WEB_PORT}（日志：${LOG_DIR}/dsh-web.log）"
  WECHAT_PORT="${DSH_BRIDGE_PORT}" nohup dsh web --port "${DSH_WEB_PORT}" >"${LOG_DIR}/dsh-web.log" 2>&1 &
fi

# ---------------------------------------------------------------- 7. 自检与收尾
say "等待桥端点就绪（最多 60 秒）..."
for i in $(seq 1 30); do
  if curl -sf -m 2 "${DSH_BRIDGE_BASE}/v1/models" >/dev/null 2>&1; then
    say "桥端点 OK：${DSH_BRIDGE_BASE}/v1/models"
    break
  fi
  [ "${i}" -eq 30 ] && warn "桥端点未就绪，稍后手动检查：curl ${DSH_BRIDGE_BASE}/v1/models（日志：${LOG_DIR}/dsh-web.log）"
  sleep 2
done

if [ -n "${KEY_READY:-}" ]; then
  say "安装完成！用微信小号给机器人发一条消息，几秒内收到回复即成功"
else
  say "安装完成！还剩两步："
  say "  1) 打开 http://127.0.0.1:${DSH_WEB_PORT} 填 DeepSeek API Key"
  say "  2) 用微信小号给机器人发一条消息，几秒内收到回复即成功"
fi
say "日常启动/自愈：重跑本脚本即可（幂等）。停止：pkill -f \"dsh web\"; pkill -f \"openclaw gateway\""
