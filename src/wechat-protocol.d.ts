/**
 * 本地类型声明：@tencent-weixin/openclaw-weixin 未提供 dist 的 .d.ts，
 * 这里为 DSH 插件实际用到的协议子模块声明最小化类型。
 *
 * 仅声明运行时真实导出的函数/常量，避免 any 泛滥。
 */
declare module '@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js' {
  export const DEFAULT_ILINK_BOT_TYPE: number;
  export function displayQRCode(qrcodeUrl: string): Promise<void>;
  export function startWeixinLoginWithQr(opts: {
    botType?: number;
    accountId?: string;
    force?: boolean;
  }): Promise<{
    qrcodeUrl?: string;
    message: string;
    sessionKey: string;
  }>;
  export function waitForWeixinLogin(opts: {
    sessionKey: string;
    timeoutMs?: number;
  }): Promise<{
    connected: boolean;
    alreadyConnected?: boolean;
    botToken?: string;
    accountId?: string;
    baseUrl?: string;
    scannedUserId?: string;
  }>;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/api/api.js' {
  export interface WeixinApiOptions {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    longPollTimeoutMs?: number;
  }

  export function getUpdates(params: WeixinApiOptions & {
    get_updates_buf?: string;
    abortSignal?: AbortSignal;
  }): Promise<{
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: Array<Record<string, unknown>>;
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
  }>;

  export function sendMessage(params: WeixinApiOptions & {
    body: Record<string, unknown>;
  }): Promise<void>;

  export function buildBaseInfo(): Record<string, unknown>;
  export const DEFAULT_LONG_POLL_TIMEOUT_MS: number;
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/api/types.js' {
  export const MessageType: { NONE: number; USER: number; BOT: number };
  export const MessageItemType: { NONE: number; TEXT: number; IMAGE: number; VOICE: number; FILE: number; VIDEO: number };
  export const MessageState: { NEW: number; GENERATING: number; FINISH: number };
  export interface WeixinMessage {
    seq?: number;
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    message_type?: number;
    message_state?: number;
    item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
    context_token?: string;
    run_id?: string;
  }
}
