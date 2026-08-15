/* Vendor'd from @tencent-weixin/openclaw-weixin (C) 2026 Tencent, MIT. */
/* Modified heavily: the original imported `openclaw/plugin-sdk/{account-id,core,config-runtime}`
 * and maintained a full OpenClaw account store. In the DSH plugin we do NOT read openclaw.json
 * nor keep OpenClaw per-account files — credentials live in ~/.dsh/wechat/accounts.json managed
 * by src/wechat-channel.ts. This minimal accounts.ts only supplies the symbols the vendored
 * protocol modules import from `../auth/accounts`, so bot_agent / routeTag simply fall back to
 * defaults and QR login builds an empty local_token_list. Protocol behavior is otherwise intact.
 */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** bot_agent config — no openclaw.json in DSH; return undefined so api.ts falls back to "OpenClaw". */
export function loadConfigBotAgent(): string | undefined {
  return undefined;
}

/** routeTag config — no openclaw.json in DSH; return undefined (header omitted). */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}

/** Per-account credential shape (subset of the original WeixinAccountData). */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
};

/** No OpenClaw account index in DSH — QR login sends an empty local_token_list. */
export function listIndexedWeixinAccountIds(): string[] {
  return [];
}

/** No OpenClaw account store in DSH — always no stored credential. */
export function loadWeixinAccount(_accountId?: string): WeixinAccountData | null {
  return null;
}

/** Raw-ID compatibility helper kept for sync-buf.ts; no OpenClaw IDs to reverse in DSH. */
export function deriveRawAccountId(_normalizedId: string): string | undefined {
  return undefined;
}
