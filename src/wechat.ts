/**
 * dsh-plugin-wechat —— DeepSeek Harness 个人微信 ClawBot 插件入口。
 *
 * 架构（复盘修正版）：
 *   - 微信通道（扫码登录、收/发消息）由 OpenClaw 网关 + 官方
 *     `@tencent-weixin/openclaw-weixin` 渠道插件负责（原脚手架误把它当独立
 *     SDK 用 `new Claw()`，它实际是 OpenClaw 宿主插件，不导出可实例化类）。
 *   - 本插件在 DSH 进程内启动一个 OpenAI 兼容端点（127.0.0.1:8787），
 *     把 OpenClaw 的模型请求翻译成对 DSH agent 的一次会话调用——
 *     OpenClaw 只需要 `models.providers.dsh.baseUrl` 指向这里，
 *     微信机器人就有了 DSH 的全部能力（工具、文件、会话、网页等）。
 *
 * 插件契约：`name` / `inject` / `apply`。`apply` 返回异步 disposer，
 * 卸载时自动关闭 HTTP 服务并销毁所有 agent 会话。
 */
import type { Context } from '@deepseek-ai/cordis';
// 引入 @deepseek-ai/dsh-agent-default-model 的类型增强，使 ctx.agentDefaultModel 可用
import type {} from '@deepseek-ai/dsh-agent-default-model';

import { Bridge } from './bridge.js';
import { SessionManager } from './sessions.js';

export const name = 'wechat';
// 依赖 DSH 的 agent 注册表（@deepseek-ai/dsh-agent）与默认模型选择服务
// （@deepseek-ai/dsh-agent-default-model，dsh-base 已内置）；就绪前本插件保持未激活。
export const inject = ['agents', 'agentDefaultModel'];

export interface WechatConfig {
  /** 监听地址，默认 127.0.0.1（仅本机，建议保持）。 */
  host?: string;
  /** 监听端口，默认 8787。 */
  port?: number;
  /** Bearer 共享密钥；留空不鉴权。 */
  apiKey?: string;
  /** per-user：每个微信发送者一个 DSH 会话；single：全部共用。默认 per-user。 */
  sessionMode?: 'per-user' | 'single';
  /** 创建 agent 时指定的 provider（env WECHAT_PROVIDER）。 */
  provider?: string;
  /** 创建 agent 时指定的模型（env WECHAT_MODEL）。 */
  model?: string;
  /** 单轮回复超时毫秒（env WECHAT_IDLE_TIMEOUT_MS），默认 180000。 */
  idleTimeoutMs?: number;
  /** 对外暴露的模型 id（env WECHAT_BRIDGE_MODEL_ID），默认 'dsh-agent'。 */
  bridgeModelId?: string;
  /** 微信会话的工作目录（env WECHAT_WORKSPACE），默认 dsh 启动目录。 */
  workspace?: string;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  apiKey: '',
  sessionMode: 'per-user',
  idleTimeoutMs: 180_000,
  bridgeModelId: 'dsh-agent',
  /** 兜底默认模型（仅当 DSH 未配置任何默认模型时使用）。 */
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
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
      // 显式配置优先；否则读 DSH 设置的默认模型；最后用内置兜底
      const selection = ctx.agentDefaultModel?.currentSelection();
      return {
        provider: config.provider ?? selection?.provider ?? DEFAULTS.provider,
        model: config.model ?? selection?.model ?? DEFAULTS.model,
      };
    },
  });

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

/** 解析后的配置；provider/model 可为空（沿用 DSH 设置的默认模型）。 */
interface ResolvedConfig {
  host: string;
  port: number;
  apiKey: string;
  sessionMode: 'per-user' | 'single';
  provider: string | undefined;
  model: string | undefined;
  idleTimeoutMs: number;
  bridgeModelId: string;
  workspace: string;
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
    provider: env.WECHAT_PROVIDER ?? raw.provider,
    model: env.WECHAT_MODEL ?? raw.model,
    idleTimeoutMs: numEnv(env.WECHAT_IDLE_TIMEOUT_MS) ?? raw.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
    bridgeModelId:
      env.WECHAT_BRIDGE_MODEL_ID ?? raw.bridgeModelId ?? DEFAULTS.bridgeModelId,
    workspace: env.WECHAT_WORKSPACE ?? raw.workspace ?? process.cwd(),
  };
}

function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
