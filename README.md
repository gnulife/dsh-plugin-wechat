# dsh-plugin-wechat

把 DeepSeek Harness（DSH）变成你的**个人微信机器人**：微信扫码接入，每条消息由 DSH 的 AI（带工具和记忆）回复。

## 快速开始（一条命令 + 扫码）

**准备**：一台电脑（macOS / Linux；Windows 请用 Git Bash 或 WSL）、Node.js ≥ 22、一个**微信账号**。

```bash
# 一条命令：自动安装 DSH、本插件，并启动微信通道（DSH 单进程，无需 OpenClaw）
npx -y dsh-plugin-wechat
```

> 不想用 npx 也可以：`npm i -g dsh-plugin-wechat` 后运行 `dsh-wechat-setup`；
> 或从 GitHub 仓库运行：`git clone https://github.com/gnulife/dsh-plugin-wechat.git && cd dsh-plugin-wechat && bash scripts/setup.sh`

脚本运行过程中只需你做两件事（都只有第一次需要）：

1. **扫码**：终端里会出现二维码 → 用手机微信扫码确认。
2. **填 API Key**：脚本会提示你打开 **http://127.0.0.1:3080** → 「设置 → 模型」填入 DeepSeek API Key。

完成后：直接用微信给机器人发消息，几秒内收到回复即成功。

**日常使用**：重跑 `bash scripts/setup.sh` 即可（幂等）。
**停止**：`pkill -f "dsh web"`
**日志**：`~/.dsh-plugin-wechat/logs/`

> 架构：本插件内置微信官方协议（MIT 许可的协议核心），在 DSH 单进程内完成扫码登录、长轮询收消息、agent 回复、发送。无需单独的 OpenClaw 网关。
>
> 搜索：机器人支持**联网搜索**（复用 DeepSeek API Key，零额外配置）。问它"最新的新闻""某个实时信息"，它会用 `web_search` 工具查询后回答。可用 `WECHAT_ENABLE_SEARCH=false` 关闭。

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
| 微信收到「Something went wrong...」 | ① DSH 里模型没配好：打开 3080 网页确认能正常对话；② 重跑 setup.sh |
| 微信不回消息 | 重跑 `bash scripts/setup.sh`；确认微信已登录（`ls ~/.dsh/wechat/accounts.json` 存在）；否则运行 `node scripts/login.js` 重新扫码 |
| 需要换账号/重新登录 | `rm -rf ~/.dsh/wechat/accounts.json && node scripts/login.js`（或 `dsh-wechat-login`） |
| 回复超时 | 模型请求慢或 API Key 未填。先在 http://127.0.0.1:3080 正常聊一句确认 |
| 回复带 `#`、`*` 等符号 | 正常现象：AI 输出是 Markdown，微信按纯文本显示 |
| 发图片/语音 | 目前只支持文字消息，其他类型会收到"暂不支持"提示 |

**（macOS）DSH 开机自启（不用每次手动启动）**

用 macOS 的 launchd 把 DSH web（含微信通道）注册为开机自启 + 崩溃自动重启的后台服务。

**一次性配置（三步）：**

```bash
# 1. 确保已登录过微信（凭证会持久化），只需一次：
node scripts/login.js          # 扫码登录，或确认 ~/.dsh/wechat/accounts.json 已存在

# 2. 安装并启动自启服务：
bash scripts/service.sh install

# 3. 验证：
bash scripts/service.sh status # 应显示服务已加载、运行中
```

配置完成后，**每次开机 DSH 自动启动，微信机器人自动在线**，无需任何手动操作。

**日常管理：**

```bash
bash scripts/service.sh status     # 查看是否在运行
bash scripts/service.sh restart    # 重启（改完配置后）
bash scripts/service.sh stop       # 暂停机器人
# 注意 service.sh 提供的是 start / stop / status / uninstall，restart 用 start（会自动重启）
bash scripts/service.sh start      # 重新启动
bash scripts/service.sh uninstall  # 卸载自启，恢复手动前台运行
```

**查看日志：**

```bash
tail -f ~/.dsh-plugin-wechat/logs/dsh-web.log      # DSH 运行日志
tail -f ~/.dsh-plugin-wechat/logs/dsh-web.err.log   # 错误日志
```

**说明：**
- 首次登录仍需终端扫码一次（`node scripts/login.js`）。登录凭证持久化到
  `~/.dsh/wechat/accounts.json` 后，开机自启即可直接后台收消息，无需再扫码。
- launchd 的 `KeepAlive` 保证 DSH 意外退出会自动重启。
- 若要换端口等其他配置，用环境变量（见下节），改完跑 `service.sh start` 生效。

## 可选项（一般不用动）

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WECHAT_SESSION_MODE` | `per-user` | `single`=所有微信好友共用一个会话 |
| `WECHAT_WORKSPACE` | dsh 启动目录 | 微信会话的工作目录（agent 的工具操作范围） |
| `WECHAT_FORCE_LOGIN` | false | `true`=启动时强制重新扫码登录 |
| `WECHAT_MODE` | `native` | `bridge`=启用 OpenAI 兼容桥（兼容旧客户端） |
| `WECHAT_ENABLE_SEARCH` | true | 允许微信机器人联网搜索（`false`=关闭，只聊天） |
| `DSH_WEB_PORT` | `3080` | DSH web 端口 |

## 注意事项

- 本方案使用**腾讯官方 ClawBot（iLink）通道**，官方支持、协议合规。遵守《微信ClawBot功能使用条款》即可。
- 机器人收到消息会进入 DSH 会话与模型请求，注意内容；保持 DSH 权限为 `workspace-write`（勿开 `danger-full-access`），桥默认只监听本机。
- 建议只做被动回复，不群发、不营销。

## 许可

MIT
