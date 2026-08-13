#!/usr/bin/env bash
# =============================================================================
# dsh-plugin-wechat 一键安装脚本（OpenClaw 侧）
#
# 作用：在 DSH 旁边装好 OpenClaw 网关 + 腾讯官方微信渠道插件，
#       扫码登录微信，并把 OpenClaw 的模型 Provider 指向 DSH 的
#       OpenAI 兼容端点（默认 http://127.0.0.1:8787）。
#
# 用法：
#   bash scripts/install-openclaw.sh            # 全部默认值
#   bash scripts/install-openclaw.sh 8899       # 自定义 DSH 桥端口
#
# 前提：Node.js >= 22、bash、能联网、手机装了微信。
# 风险提示：个人微信自动化有封号风险，强烈建议使用微信小号。
# =============================================================================
set -euo pipefail

DSH_BRIDGE_PORT="${1:-8787}"
DSH_BRIDGE_BASE="http://127.0.0.1:${DSH_BRIDGE_PORT}"
PROVIDER_NAME="dsh"
MODEL_ID="dsh-agent"
API_KEY="${WECHAT_BRIDGE_API_KEY:-}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"

say()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 前置检查
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js >= 22（https://nodejs.org）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR:-0}" -ge 22 ] || warn "检测到 Node v${NODE_MAJOR}，建议 >= 22"

command -v openclaw >/dev/null 2>&1 || {
  say "未检测到 openclaw，正在全局安装（npm i -g openclaw）..."
  npm install -g openclaw
}

# ---------------------------------------------------------------- 1. 安装微信渠道插件
if openclaw plugins list 2>/dev/null | grep -q "openclaw-weixin"; then
  say "微信通道插件已安装，跳过"
else
  say "安装腾讯官方微信渠道插件 @tencent-weixin/openclaw-weixin ..."
  openclaw plugins install "@tencent-weixin/openclaw-weixin"
  openclaw config set plugins.entries.openclaw-weixin.enabled true
  # 网关本地模式（openclaw gateway 启动的必要配置，缺了网关会拒绝启动）
  openclaw config set gateway.mode local
fi

# ---------------------------------------------------------------- 2. 扫码登录
say "开始微信扫码登录 —— 请用【微信小号】扫描终端里出现的二维码并确认。"
say "登录凭据会保存在 ~/.openclaw 下，之后无需重复扫码。"
openclaw channels login --channel openclaw-weixin

# ---------------------------------------------------------------- 3. 配置模型 Provider 指向 DSH
say "配置模型 Provider: ${PROVIDER_NAME} -> ${DSH_BRIDGE_BASE}/v1（模型 ${MODEL_ID}）"
# 注意：自定义 provider 必须整体写入（openclaw config set 单字段会校验失败），
# baseUrl 必须带 /v1 后缀（openclaw 会拼 /chat/completions）。
node -e '
  const fs = require("fs"), path = require("path");
  const p = process.argv[1];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const provider = process.argv[2];
  const modelId = process.argv[3];
  const baseUrl = process.argv[4];
  const apiKey = process.argv[5];
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  cfg.models = cfg.models ?? {};
  cfg.models.providers = cfg.models.providers ?? {};
  cfg.models.providers[provider] = {
    ...(cfg.models.providers[provider] ?? {}),
    baseUrl,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: cfg.models.providers[provider]?.models ?? [
      { id: modelId, name: "DSH Agent", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 }
    ],
  };
  cfg.agents = cfg.agents ?? {};
  cfg.agents.defaults = cfg.agents.defaults ?? {};
  cfg.agents.defaults.model = cfg.agents.defaults.model ?? { primary: provider + "/" + modelId };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "${OPENCLAW_CONFIG}" "${PROVIDER_NAME}" "${MODEL_ID}" "${DSH_BRIDGE_BASE}/v1" "${API_KEY}"
if [ -n "${API_KEY}" ]; then
  say "已写入共享密钥（来自环境变量 WECHAT_BRIDGE_API_KEY）"
else
  say "未设置 WECHAT_BRIDGE_API_KEY —— DSH 桥未启用鉴权（仅本机监听，风险可控）。"
  warn "若要鉴权：export WECHAT_BRIDGE_API_KEY=你的密钥 后重新运行本脚本。"
fi

# ---------------------------------------------------------------- 4. 收尾
say "配置完成。推荐直接用一条命令完成全部安装与日常使用："
say "  bash scripts/setup.sh      # 自动装 DSH/插件/OpenClaw/微信通道，并启动全部"
say "用微信小号给机器人发消息测试即可。"
say "一键验证桥是否通：curl -s ${DSH_BRIDGE_BASE}/v1/models"
