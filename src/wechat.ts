/**
 * dsh-plugin-wechat —— DeepSeek Harness 个人微信 ClawBot 插件入口。
 *
 * 两种模式：
 *   - native（默认）：DSH 单进程。直接调用腾讯官方 openclaw-weixin 的纯协议模块
 *     （MIT 许可）做扫码登录 + 长轮询，消息直连 ctx.agents。彻底移除 OpenClaw 网关。
 *   - bridge（兼容/回退）：在 DSH 内起 OpenAI 兼容桥，供外部 OpenAI 客户端接入。
 *
 * 插件契约：`name` / `inject` / `apply`。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-default-model';

import { Bridge } from './bridge.js';
import { SessionManager } from './sessions.js';
import { WechatChannel } from './wechat-channel.js';

export const name = 'wechat';
// 依赖 DSH 的 agent 注册表与默认模型选择服务；就绪前插件保持未激活。
export const inject = ['agents', 'agentDefaultModel'];

export interface WechatConfig {
  /** mode=bridge 时监听地址，默认 127.0.0.1。 */
  host?: string;
  /** mode=bridge 时监听端口，默认 8787。 */
  port?: number;
  /** mode=bridge 时 Bearer 共享密钥；留空不鉴权。 */
  apiKey?: string;
  /**
   * native（默认）：DSH 单进程直连微信协议。
   * bridge：起 OpenAI 兼容桥（兼容/回退）。
   */
  mode?: 'native' | 'bridge';
  /** per-user：每个微信发送者一个 DSH 会话；single：全部共用。 */
  sessionMode?: 'per-user' | 'single';
  /** 创建 agent 时指定的 provider。 */
  provider?: string;
  /** 创建 agent 时指定的模型。 */
  model?: string;
  /** 单轮回复超时毫秒，默认 180000。 */
  idleTimeoutMs?: number;
  /** 对外暴露的模型 id（bridge 用），默认 'dsh-agent'。 */
  bridgeModelId?: string;
  /** 会话工作目录，默认 dsh 启动目录。 */
  workspace?: string;
  /** native 模式：强制重新扫码登录。 */
  forceLogin?: boolean;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  apiKey: '',
  sessionMode: 'per-user',
  idleTimeoutMs: 180_000,
  bridgeModelId: 'dsh-agent',
  mode: 'native',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  forceLogin: false,
} as const;

export async function apply(
  ctx: Context,
  rawConfig: WechatConfig = {},
): Promise<() => Promise<void>> {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger('wechat');

  const sessions = new SessionManager(ctx, {
    sessionPrefix: 'wechat',
    cwd: config.workspace,
    idleTimeoutMs: config.idleTimeoutMs,
    resolveAgentOptions: () => {
      const selection = ctx.agentDefaultModel?.currentSelection();
      return {
        provider: config.provider ?? selection?.provider ?? DEFAULTS.provider,
        model: config.model ?? selection?.model ?? DEFAULTS.model,
      };
    },
  });

  if (config.mode === 'bridge') {
    return startBridge(ctx, config, sessions);
  }

  // native 模式：DSH 单进程
  const channel = new WechatChannel(ctx, sessions, {
    forceLogin: config.forceLogin,
    cwd: config.workspace,
  });
  try {
    await channel.login(config.forceLogin);
    await channel.start();
    logger.info('wechat: DSH 原生通道已启动（扫描/长轮询中）');
  } catch (err) {
    logger.warn('wechat native 启动失败：', (err as Error).message);
    // 不退出插件，仅告警；可重试 login(true)
  }

  return async () => {
    channel.stop();
    await sessions.dispose();
    logger.info('wechat plugin stopped');
  };
}

async function startBridge(
  ctx: Context,
  config: ResolvedConfig,
  sessions: SessionManager,
): Promise<() => Promise<void>> {
  const logger = ctx.logger('wechat');
  const bridge = new Bridge({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    modelId: config.bridgeModelId,
    logger: (message, ...args) => logger.info(message, ...args),
    handleCompletion: async (userKey, text) => {
      const sessionKey = config.sessionMode === 'single' ? 'default' : userKey;
      logger.info(`agent request [${sessionKey}]: ${text.slice(0, 120)}`);
      return sessions.send(sessionKey, text);
    },
  });
  try {
    await bridge.start();
  } catch (err) {
    throw new Error(
      `dsh-plugin-wechat: 无法监听 ${config.host}:${config.port} —— ${(err as Error).message}。` +
        '请确认端口未被占用，或通过配置 host/port 换一个端口。',
      { cause: err },
    );
  }
  logger.info(`OpenAI-compatible bridge listening on http://${config.host}:${config.port} (model: ${config.bridgeModelId})`);
  return async () => {
    await bridge.close();
    await sessions.dispose();
    logger.info('wechat plugin stopped');
  };
}

/** 解析后的配置。 */
interface ResolvedConfig {
  host: string;
  port: number;
  apiKey: string;
  sessionMode: 'per-user' | 'single';
  mode: 'native' | 'bridge';
  provider: string | undefined;
  model: string | undefined;
  idleTimeoutMs: number;
  bridgeModelId: string;
  workspace: string;
  forceLogin: boolean;
}

function normalizeConfig(raw: WechatConfig): ResolvedConfig {
  const env = process.env;
  return {
    host: env.WECHAT_HOST ?? raw.host ?? DEFAULTS.host,
    port: numEnv(env.WECHAT_PORT) ?? raw.port ?? DEFAULTS.port,
    apiKey: env.WECHAT_API_KEY ?? raw.apiKey ?? DEFAULTS.apiKey,
    sessionMode:
      env.WECHAT_SESSION_MODE === 'single' || raw.sessionMode === 'single'
        ? 'single'
        : 'per-user',
    mode: env.WECHAT_MODE === 'bridge' || raw.mode === 'bridge' ? 'bridge' : 'native',
    provider: env.WECHAT_PROVIDER ?? raw.provider,
    model: env.WECHAT_MODEL ?? raw.model,
    idleTimeoutMs: numEnv(env.WECHAT_IDLE_TIMEOUT_MS) ?? raw.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
    bridgeModelId: env.WECHAT_BRIDGE_MODEL_ID ?? raw.bridgeModelId ?? DEFAULTS.bridgeModelId,
    workspace: env.WECHAT_WORKSPACE ?? raw.workspace ?? process.cwd(),
    forceLogin: env.WECHAT_FORCE_LOGIN === 'true' || raw.forceLogin || DEFAULTS.forceLogin,
  };
}

function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
