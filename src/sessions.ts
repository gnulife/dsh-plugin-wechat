/**
 * DSH agent 会话管理：把"一个微信发送者"映射为一个常驻 DSH agent 会话。
 *
 * 关键设计：
 * - 每个 userKey 对应一个独立的 DSH 会话（sessionId = wechat-<hash>），
 *   历史由 DSH 自己维护，微信侧只需发最新一条消息。
 * - 同一 userKey 的请求按到达顺序串行化（chain），保证"第 N 次请求的回复"
 *   就是会话里第 N 条 assistant 消息，不会互相串台。
 * - 回复通过 `agent.whenIdle()`（整个 agent 活动进入静止）后回扫会话日志里
 *   最新一条 `assistant/message` 事件取得。
 */
import { createHash } from 'node:crypto';

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export interface SessionManagerOptions {
  /** sessionId 前缀，默认 'wechat'。 */
  readonly sessionPrefix?: string;
  /** 会话工作目录（DSH 提示词组装需要 {{cwd}}，缺失会直接失败）。 */
  readonly cwd?: string;
  /** 单轮回复超时（毫秒），默认 180000。 */
  readonly idleTimeoutMs?: number;
  /**
   * 创建 agent 时解析 provider/model（如 DSH 设置的默认模型）。
   * 返回 undefined 时 agent 将因缺少模型而无法运行，插件会收到明确报错。
   */
  readonly resolveAgentOptions?: () => { provider: string; model: string } | undefined;
}

interface Managed {
  readonly handle: AgentHandle;
  /** 该会话的串行链；前一个请求结束后才发起下一个。 */
  chain: Promise<void>;
}

export class SessionManager {
  private readonly sessions = new Map<string, Managed>();
  private readonly creating = new Map<string, Promise<Managed>>();

  constructor(
    private readonly ctx: Context,
    private readonly options: SessionManagerOptions = {},
  ) {}

  /**
   * 把一个 userKey 的文本送进对应的 DSH agent 会话，等待并返回回复文本。
   */
  async send(userKey: string, text: string): Promise<string> {
    const managed = await this.ensure(userKey);
    const task = managed.chain.then(() => this.runTurn(managed, text));
    // 链上只保留"完成与否"，绝不让前序失败阻塞后续请求
    managed.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 停止并销毁所有会话。 */
  async dispose(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.creating.clear();
    await Promise.allSettled(entries.map((m) => m.handle.dispose()));
  }

  private async runTurn(managed: Managed, text: string): Promise<string> {
    const agent = managed.handle.agent;
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'wechat' },
      }),
    );

    const timeoutMs = this.options.idleTimeoutMs ?? 180_000;
    await withTimeout(
      agent.whenIdle(),
      timeoutMs,
      `DSH agent 未在 ${timeoutMs}ms 内完成回复（可能是模型请求超时或会话卡住）`,
    );

    const reply = lastAssistantText(agent);
    if (!reply) {
      throw new Error('DSH agent 没有产生回复文本');
    }
    return reply;
  }

  /** 取（或建）一个 userKey 对应的会话，创建过程对并发安全。 */
  private ensure(userKey: string): Promise<Managed> {
    const existing = this.sessions.get(userKey);
    if (existing) return Promise.resolve(existing);

    const inflight = this.creating.get(userKey);
    if (inflight) return inflight;

    const created = this.create(userKey).then((managed) => {
      this.sessions.set(userKey, managed);
      return managed;
    });
    this.creating.set(userKey, created);
    void created.finally(() => this.creating.delete(userKey));
    return created;
  }

  private async create(userKey: string): Promise<Managed> {
    const digest = createHash('sha256').update(userKey).digest('hex').slice(0, 16);
    const sessionId = SessionId(`${this.options.sessionPrefix ?? 'wechat'}-${digest}`);

    const agentOptions = this.options.resolveAgentOptions?.();
    const cwd = this.options.cwd;
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions,
      ...(cwd ? { meta: { cwd } } : {}),
    });
    return { handle, chain: Promise.resolve() };
  }
}

/** 从会话日志回扫最新一条 assistant 消息，拼接其中的文本块。 */
function lastAssistantText(agent: Agent): string {
  const events = agent.session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'assistant/message') {
      return textOf(event.data.message.content);
    }
  }
  return '';
}

/** 只取可见文本块（过滤 reasoning / tool 块）。 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
