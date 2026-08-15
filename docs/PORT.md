# 移植方案：openclaw-weixin → DSH 内置微信通道插件

## 目标

将微信协议核心从 openclaw-weixin（MIT）移植为 DSH 插件内嵌模块，
使 DSH **单进程**承载微信 ClawBot，彻底移除 OpenClaw 网关。
符合 DSH 插件化哲学：一切皆插件，微信通道就是一个 DSH 插件。

## 可行性结论（已实测+源码级验证）

| 事实 | 证据 |
|------|------|
| 协议核心是纯 Node | `api.js`/`login-qr.js` 可在无 openclaw 环境独立 import，`getUpdates`/`sendMessage` 可调用 |
| MIT 许可 | 全部源码 (C) 2026 Tencent, MIT, 可合法移植(保留版权声明) |
| 缺 openclaw 不炸 | 干净目录 install 后无 openclaw，协议模块正常工作 |
| 长轮询超时是控制流 | AbortError 被吞掉返回空响应，非错误 |
| <tool_calls> 残留 | StreamingMarkdownFilter 无法处理(它只剥字符md)，须靠"禁用工具"指令根治 |

## 架构：DSH 单进程

```
微信用户 ⇄ ilink网关(腾讯官方)
   ↑ 长轮询 getUpdates (游标续传)
   ↓ sendMessage (context_token)
DSH 单进程:
  [wechat 插件]
    protocol layer   ← 照搬 openclaw-weixin: api.js + login-qr.js + types
    monitor loop     ← 重写(去掉 openclaw channel-runtime)
    → ctx.agents.createSession(id=wechat-<chat_id>)
    → agent.followup(text)
    → 回扫 assistant/message → sendMessage
```
不再有：OpenClaw 网关、openclaw.json、OpenAPI 桥、provider 配置。

## 移植范围

### 照搬（纯协议,不依赖 openclaw）
- `api/api.ts` → getUpdates/sendMessage/getConfig/getUploadUrl/buildBaseInfo
- `auth/login-qr.ts` → startWeixinLoginWithQr/displayQRCode/waitForWeixinLogin
- `api/types.ts` → 消息/命令类型定义
- `messaging/inbound.ts` → weixinMessageToMsgContext 文本提取 + context_token 存储
- `config/config-schema.ts` → 参数校验
- `util/logger.ts`/`redact.ts`/`random.ts` → 工具
- `storage/sync-buf.ts` → get_updates 游标持久化
- `messaging/send.ts`(仅文本) → buildTextMessageReq + StreamingMarkdownFilter

### 重写（去掉 openclaw 依赖）
- `monitor/monitor.ts` → 简化长轮询循环,错误处理保留(3次→30s退避)
- `auth/accounts.ts` → 存储改到 DSH state dir,读 bot_agent 改回调
- `auth/pairing.ts` → 去掉 openclaw allowList,改为 DSH 内简单配置(如:all 或白名单)
- `messaging/process-message.ts` → 去掉 channel-runtime 路由/会话/派发,直接对接 ctx.agents
- `channel.ts` → 完全重写为 DSH 插件 apply()

### 二期(暂不移植)
- 媒体(图片/文件)收发 — 依赖 CDN 加解密+openclaw media 管线
- 语音 silk→wav 转码
- 多账号

## 安全设计
- 凭证: bot_token 存 DSH state dir (chmod 600),不写入环境/日志
- 会话隔离: sessionId = wechat-<sha256(chat_id)[:16]>,每好友独立会话
- 权限: 微信 agent 仅文本闲聊,无工具(系统提示禁用),cwd 固定
- 登录: 扫码,二维码仅终端显示,token 落盘可清理
- 白名单: 可选 allowFrom 配置(默认全部)

## 文件规划 (src/)
```
src/wechat/            # 或扁平
  protocol/            # 照搬自 openclaw-weixin (带 LICENSE/Tencent 声明)
    api.ts  login.ts  types.ts  sync-buf.ts  ...
  monitor.ts           # 重写: 长轮询循环
  accounts.ts          # 重写: 凭证存储(DSH state)
  inbound.ts           # 重写: 消息→agent
  outbound.ts          # 重写: agent回复→sendMessage
  markdown.ts          # 照搬 StreamingMarkdownFilter
  index.ts             # DSH 插件入口 (apply)
  session.ts           # 复用以有 SessionManager 或内联
```

## 测试/验收
- 单元: 协议函数 + markdown 过滤器
- 隔离端到端: fake HOME + stub ilink → 登录→收→agent回复→发
- 真实验收: 扫码登录→微信收发(需真机)

## 风险
- 协议变更需自行跟进(不再享受 openclaw-weixin 官方更新) ← 最大长期风险
- 媒体/语音二期,初期仅文本
- README 更新为单进程
