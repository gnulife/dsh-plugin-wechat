/**
 * wechat-channel —— DSH 原生微信通道模块（替代 OpenClaw 网关）。
 *
 * 直接调用腾讯官方 openclaw-weixin 的纯协议模块（MIT 许可）：
 *   - login-qr:  startWeixinLoginWithQr / waitForWeixinLogin 扫码登录
 *   - api:       getUpdates（长轮询）/ sendMessage（发送）
 *
 * 本模块把微信长轮询收到的文本消息直接送入 `ctx.agents` 会话，
 * agent 回复后经 sendMessage 回发。全程在 DSH 单进程内完成，
 * 不再需要 OpenClaw 网关、openclaw.json、OpenAI 桥。
 *
 * 安全：凭证存 DSH state dir（chmod 600），会话按 chat_id 隔离，
 *       微信 agent 无工具、cwd 固定。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { type Context } from '@deepseek-ai/cordis';
import {
  DEFAULT_ILINK_BOT_TYPE,
  displayQRCode,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from './wechat/protocol/auth/login-qr.js';
import { getUpdates, sendMessage } from './wechat/protocol/api/api.js';
import { MessageItemType, MessageState, MessageType, type WeixinMessage } from './wechat/protocol/api/types.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

import type { SessionManager } from './sessions.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface WechatChannelConfig {
  /** 扫描登录是否强制（每次扫码）。默认 false：已有凭证直接复用。 */
  forceLogin?: boolean;
  /** 长轮询超时（毫秒）。默认 35000。 */
  longPollTimeoutMs?: number;
  /** 会话工作目录。 */
  cwd?: string;
  /** state 目录（默认 ~/.dsh/wechat）。 */
  stateDir?: string;
}

interface StoredAccount {
  accountId: string;
  botToken: string;
  baseUrl?: string;
  userIp?: string;
  boundAt: number;
  // 每个 chat_id 的 context_token（回发必带）
  contextTokens: Record<string, string>;
  // get_updates 游标
  syncBuf: string;
}

export class WechatChannel {
  private accounts = new Map<string, StoredAccount>();
  private activeAccountId: string | undefined;
  private polling = false;
  private controller: AbortController | undefined;
  private stateFile: string;

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionManager,
    private readonly config: WechatChannelConfig = {},
  ) {
    this.stateFile = join(config.stateDir ?? join(homedir(), '.dsh', 'wechat'), 'accounts.json');
    this.loadState();
  }

  // ---------------------------------------------------------------- 凭证存储
  private loadState(): void {
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, StoredAccount>;
        for (const [id, acct] of Object.entries(raw)) this.accounts.set(id, acct);
        this.activeAccountId = [...this.accounts.keys()][0];
      }
    } catch (e) {
      this.ctx.logger('wechat').error('load wechat accounts failed:', e);
    }
  }

  private saveState(): void {
    mkdirSync(join(this.stateFile, '..'), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.accounts), null, 2), 'utf8');
    try { chmodSync(this.stateFile, 0o600); } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- 登录
  async login(force = false): Promise<void> {
    const forceLogin = force || this.config.forceLogin || false;
    const existing = this.activeAccountId ? this.accounts.get(this.activeAccountId) : undefined;
    if (existing && !forceLogin) {
      this.ctx.logger('wechat').info(`已登录(账号 ${existing.accountId})，复用凭证`);
      return;
    }

    this.ctx.logger('wechat').info('开始微信扫码登录（请用微信扫描终端二维码）...');
    const apiBaseUrl = DEFAULT_BASE_URL;
    const start = await startWeixinLoginWithQr({ botType: DEFAULT_ILINK_BOT_TYPE, apiBaseUrl });
    if (start.qrcodeUrl) await displayQRCode(start.qrcodeUrl);

    const sessionKey = start.sessionKey;
    // 轮询等待扫码确认
    const wait = await waitForWeixinLogin({ sessionKey, timeoutMs: 300_000, apiBaseUrl, botType: String(DEFAULT_ILINK_BOT_TYPE) });

    if (!wait.connected) {
      throw new Error('微信扫码登录超时或未确认');
    }
    if (wait.alreadyConnected && this.activeAccountId) {
      this.ctx.logger('wechat').info('账号已绑定，沿用现有凭证');
      return;
    }
    const accountId = wait.accountId ?? `wechat-${randomUUID().slice(0, 8)}`;
    this.accounts.set(accountId, {
      accountId,
      botToken: wait.botToken ?? '',
      baseUrl: wait.baseUrl || DEFAULT_BASE_URL,
      boundAt: Date.now(),
      contextTokens: {},
      syncBuf: '',
    });
    this.activeAccountId = accountId;
    this.saveState();
    this.ctx.logger('wechat').info(`登录成功，账号 ${accountId}`);
  }

  // ---------------------------------------------------------------- 监控
  async start(agentId?: string): Promise<void> {
    if (!this.activeAccountId) {
      this.ctx.logger('wechat').warn('未登录，先调用 login()');
      return;
    }
    if (this.polling) return;
    this.polling = true;
    this.controller = new AbortController();
    const acct = this.accounts.get(this.activeAccountId)!;
    void this.runPoll(acct);
  }

  stop(): void {
    this.polling = false;
    this.controller?.abort();
  }

  private async runPoll(acct: StoredAccount): Promise<void> {
    let failures = 0;
    let nextTimeout = this.config.longPollTimeoutMs ?? 35_000;
    while (this.polling) {
      if (this.controller?.signal.aborted) break;
      try {
        const resp = await getUpdates({
          baseUrl: acct.baseUrl ?? DEFAULT_BASE_URL,
          token: acct.botToken,
          get_updates_buf: acct.syncBuf,
          timeoutMs: nextTimeout,
          abortSignal: this.controller!.signal,
        });
        failures = 0;
        if (resp.get_updates_buf) {
          acct.syncBuf = resp.get_updates_buf;
          this.saveState();
        }
        if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
          nextTimeout = resp.longpolling_timeout_ms;
        }
        if (resp.errcode === -14) {
          this.ctx.logger('wechat').warn('会话失效(-14)，请重新扫码: this.login(true)');
          this.polling = false;
          return;
        }
        for (const msg of resp.msgs ?? []) {
          await this.handleMessage(acct, msg);
        }
      } catch (err) {
        if (this.controller?.signal.aborted) break;
        failures++;
        this.ctx.logger('wechat').debug('poll error:', (err as Error).message);
        // 长轮询超时是正常控制流，不计数为失败
        if ((err as NodeJS.ErrnoException).name !== 'AbortError') {
          if (failures >= 3) {
            this.ctx.logger('wechat').error('连续失败，30s 后重试');
            await new Promise((r) => setTimeout(r, 30_000));
            failures = 0;
          } else {
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }
      }
    }
  }

  private async handleMessage(acct: StoredAccount, msg: WeixinMessage): Promise<void> {
    const isUser = msg.message_type === MessageType.USER;
    if (!isUser) return; // 只处理用户消息
    const text = extractText(msg.item_list);
    if (!text) return;   // 非文本消息暂忽略
    const chatId = msg.from_user_id;
    if (!chatId) return;
    if (msg.context_token) {
      acct.contextTokens[chatId] = msg.context_token;
      this.saveState();
    }
    this.ctx.logger('wechat').info(`微信消息 [${chatId.slice(0, 10)}...]: ${text.slice(0, 60)}`);

    try {
      const reply = await this.sessions.send(chatId, text);
      await this.reply(acct, chatId, reply);
    } catch (err) {
      this.ctx.logger('wechat').error('handle message error:', (err as Error).message);
      await this.reply(acct, chatId, '抱歉，处理消息时出错了。');
    }
  }

  private async reply(acct: StoredAccount, to: string, text: string): Promise<void> {
    const token = acct.contextTokens[to];
    const clientId = `openclaw-weixin:${randomUUID().slice(0, 12)}`;
    await sendMessage({
      baseUrl: acct.baseUrl ?? DEFAULT_BASE_URL,
      token: acct.botToken,
      body: {
        msg: {
          from_user_id: acct.accountId,
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
          context_token: token,
        },
      },
    });
  }
}

/** 从 item_list 提取纯文本（去掉 markdown 残留）。 */
function extractText(items: Array<{ type?: number; text_item?: { text?: string } }> | undefined): string {
  if (!items) return '';
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text.trim();
    }
  }
  return '';
}

/** 供 SessionManager 之外快速构造 user message 的辅助（保留）。 */
export function buildUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'wechat' },
  });
}
