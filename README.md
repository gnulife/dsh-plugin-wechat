# dsh-plugin-wechat

把 DeepSeek Harness（DSH）变成你的**个人微信机器人**：微信小号扫码接入，每条消息由 DSH 的 AI（带工具和记忆）回复。

## 快速开始（一条命令 + 扫码）

**准备**：一台电脑（macOS / Linux；Windows 请用 Git Bash 或 WSL）、Node.js ≥ 22、一个**微信小号**（勿用主号，有封号风险）。

```bash
# 一条命令：自动安装 DSH、本插件、OpenClaw、微信通道，并启动全部
npx -y dsh-plugin-wechat
```

> 不想用 npx 也可以：`npm i -g dsh-plugin-wechat` 后运行 `dsh-wechat-setup`；
> 或从 GitHub 仓库运行：`git clone https://github.com/gnulife/dsh-plugin-wechat.git && cd dsh-plugin-wechat && bash scripts/setup.sh`

脚本运行过程中只需你做两件事（都只有第一次需要）：

1. **扫码**：终端里会出现二维码 → 用手机**微信小号**扫码确认。
2. **填 API Key**：脚本会提示你打开 **http://127.0.0.1:3080** → 「设置 → 模型」填入 DeepSeek API Key。

完成后：直接用微信小号给机器人发消息，几秒内收到回复即成功。

**日常使用**：重跑 `bash scripts/setup.sh` 即可（幂等，只会把没跑起来的服务拉起来）。
**停止**：`pkill -f "dsh web"; pkill -f "openclaw gateway"`
**日志**：`~/.dsh-plugin-wechat/logs/`

## 常见问题（FAQ）

**扫码报「网络错误，请稍后重试」？**
大概率是你电脑上开了代理工具（Clash / Surge 等），把微信域名劫持走了。给微信域名加直连规则即可（Clash 系：**订阅 → 全局扩展配置（Merge）** 里加，然后保存重载）：

```yaml
prepend-rules:
  - DOMAIN-SUFFIX,weixin.qq.com,DIRECT
  - DOMAIN-SUFFIX,liteapp.weixin.qq.com,DIRECT
```

加完重跑 `bash scripts/setup.sh`。

| 问题 | 处理 |
|------|------|
| 微信收到「Something went wrong...」 | ① DSH 里模型没配好：打开 3080 网页确认能正常对话；② 刚改过配置：重跑 setup.sh（会自动重启网关） |
| 微信不回消息 | 重跑 `bash scripts/setup.sh`；再 `openclaw channels status --probe` 看通道；掉线就重跑 setup.sh（会重新引导扫码） |
| 桥端点没就绪（自检警告） | 看日志 `~/.dsh-plugin-wechat/logs/dsh-web.log`；确认 3080 网页能打开、模型已配置 |
| 回复超时 | 模型请求慢或 API Key 未填。先在 http://127.0.0.1:3080 正常聊一句确认 |
| 回复带 `#`、`*` 等符号 | 正常现象：AI 输出是 Markdown，微信按纯文本显示 |
| 发图片/语音 | 目前只支持文字消息，其他类型会收到"暂不支持"提示 |

## 可选项（一般不用动）

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WECHAT_API_KEY` | 空 | 桥的共享密钥；与他人共用机器时设置 |
| `WECHAT_SESSION_MODE` | `per-user` | `single`=所有微信好友共用一个会话 |
| `WECHAT_WORKSPACE` | dsh 启动目录 | 微信会话的工作目录（agent 的工具操作范围） |
| `DSH_BRIDGE_PORT` | `8787` | 桥端口；改动后重跑 setup.sh（OpenClaw 侧自动同步） |
| `DSH_WEB_PORT` / `OPENCLAW_GATEWAY_PORT` | `3080` / `18789` | 启动端口 |

## 风险提示

- **账号风险（官方通道但有边界）**：本方案走腾讯官方 ClawBot（iLink）通道，协议层合规，不是逆向/灰产方案；但腾讯有《微信ClawBot功能使用条款》——内容会被安全审核、记录设备/IP/操作日志，灰度期腾讯可随时调整、限制或终止服务。建议用**微信小号**绑定（勿绑主号），新号先正常使用几天再挂机器人。
- **滥用风险（提示词注入）**：任何微信好友都能给你的机器人发消息，可能诱导 agent 执行危险操作或发送违规内容。保持 DSH 权限为 `workspace-write` 或更严（勿开 `danger-full-access`），桥默认只监听本机（勿改 `0.0.0.0`），共用机器时设置 `WECHAT_API_KEY`。
- **行为规范**：只做被动回复，不群发、不营销、不骚扰，控制频率，内容合规。
- **隐私**：发给机器人的消息会进入 DSH 会话记录与模型请求，平台也会做安全审核。

## 许可

MIT
