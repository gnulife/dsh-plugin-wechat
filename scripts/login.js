/**
 * 独立微信扫码登录器：获取二维码 → 等待扫码 → 保存凭证到 ~/.dsh/wechat/accounts.json
 *
 * 用法: node scripts/login.js
 * 说明:
 *   - 二维码 URL 实时写入 ~/.dsh/wechat/login-url.txt（过期自动刷新），可用手机微信打开扫码。
 *   - 登录成功（或已绑定复用旧凭证）后写入原生模块读取的 accounts.json。
 *   - 若之前用 OpenClaw 登录过同一微信账号，会自动迁移其凭证，无需重复扫码。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from '@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js';

const API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const stateDir = join(homedir(), '.dsh', 'wechat');
const acctFile = join(stateDir, 'accounts.json');
const OC_ACCOUNTS_DIR = join(homedir(), '.openclaw', 'openclaw-weixin', 'accounts');
mkdirSync(stateDir, { recursive: true });

/** 读取原生 accounts.json（不存在则空）。 */
function loadAccounts() {
  try {
    if (existsSync(acctFile)) return JSON.parse(readFileSync(acctFile, 'utf8'));
  } catch { /* 忽略损坏 */ }
  return {};
}

/** 从 OpenClaw 旧凭证迁移到原生格式。 */
function migrateFromOpenclaw() {
  try {
    const index = JSON.parse(readFileSync(join(join(homedir(), '.openclaw', 'openclaw-weixin'), 'accounts.json'), 'utf8'));
    const accounts = loadAccounts();
    let migrated = false;
    for (const accountId of index ?? []) {
      const credFile = join(OC_ACCOUNTS_DIR, `${accountId}.json`);
      if (!existsSync(credFile) || accounts[accountId]) continue;
      const cred = JSON.parse(readFileSync(credFile, 'utf8'));
      let contextTokens = {};
      const tokFile = join(OC_ACCOUNTS_DIR, `${accountId}.context-tokens.json`);
      if (existsSync(tokFile)) contextTokens = JSON.parse(readFileSync(tokFile, 'utf8'));
      let syncBuf = '';
      const syncFile = join(OC_ACCOUNTS_DIR, `${accountId}.sync.json`);
      if (existsSync(syncFile)) syncBuf = JSON.parse(readFileSync(syncFile, 'utf8')).get_updates_buf ?? '';
      accounts[accountId] = {
        accountId,
        botToken: cred.token,
        baseUrl: cred.baseUrl || API_BASE_URL,
        boundAt: Date.parse(cred.savedAt) || Date.now(),
        contextTokens,
        syncBuf,
      };
      migrated = true;
    }
    if (migrated) {
      writeFileSync(acctFile, JSON.stringify(accounts, null, 2), 'utf8');
      process.stdout.write(`已从 OpenClaw 迁移 ${Object.keys(accounts).length} 个微信账号凭证。\n`);
    }
    return migrated;
  } catch (e) {
    process.stdout.write(`迁移 OpenClaw 凭证跳过：${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

// 若已有原生凭证，直接复用无需扫码
if (Object.keys(loadAccounts()).length > 0) {
  console.log('已有原生微信凭证，直接复用。若需重新登录，删除 ~/.dsh/wechat/accounts.json 后重跑。');
  process.exit(0);
}

// 尝试从 OpenClaw 旧凭证迁移
if (migrateFromOpenclaw()) {
  console.log('已迁移现有微信凭证，无需扫码。');
  process.exit(0);
}

// 开始扫码登录
console.log('== 微信扫码登录 ==');
try {
  const start = await startWeixinLoginWithQr({ botType: DEFAULT_ILINK_BOT_TYPE, apiBaseUrl: API_BASE_URL, force: true });
  const url = start.qrcodeUrl || '';
  writeFileSync(join(stateDir, 'login-url.txt'), url, 'utf8');
  console.log('二维码已写入 ~/.dsh/wechat/login-url.txt。请用手机微信打开扫码（过期自动刷新，最长约 10 分钟）：');
  console.log(url);

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: API_BASE_URL,
    botType: String(DEFAULT_ILINK_BOT_TYPE),
    timeoutMs: 600_000,
  });

  if (!wait.connected) {
    console.error('登录失败/超时:', wait.message);
    process.exit(1);
  }
  if (wait.alreadyConnected) {
    // 已绑定但无本地凭证 → 尝试从 OpenClaw 迁移
    if (migrateFromOpenclaw()) {
      console.log('账号已绑定，已迁移现有凭证。');
      process.exit(0);
    }
    console.error('账号已绑定但无法复用本地凭证，请删除旧 openclaw 状态后重试 login(true)。');
    process.exit(1);
  }

  const accountId = wait.accountId ?? `wechat-${randomUUID().slice(0, 8)}`;
  const accounts = loadAccounts();
  accounts[accountId] = {
    accountId,
    botToken: wait.botToken ?? '',
    baseUrl: wait.baseUrl || API_BASE_URL,
    boundAt: Date.now(),
    contextTokens: {},
    syncBuf: '',
  };
  writeFileSync(acctFile, JSON.stringify(accounts, null, 2), 'utf8');
  console.log('登录成功! 账号:', accountId);
  console.log('凭证已保存:', acctFile);
} catch (e) {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
