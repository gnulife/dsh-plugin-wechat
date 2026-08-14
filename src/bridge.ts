/**
 * OpenAI 兼容 HTTP 桥：OpenClaw 的模型 Provider 指向这里，
 * 我们把 `POST /v1/chat/completions` 翻译成对 DSH agent 的一次调用。
 *
 * 支持：
 * - `GET /v1/models` —— 让 OpenClaw 能列出模型；
 * - `POST /v1/chat/completions` —— 非流式 JSON 与 SSE 流式两种响应；
 * - 可选 Bearer 鉴权（apiKey 非空时启用）。
 *
 * 会话身份：OpenClaw 若在请求体里带 `user` 字段，则用它作为会话键；
 * 否则用 'default'（配合插件的 sessionMode: single）。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BridgeOptions {
  readonly host: string;
  readonly port: number;
  /** 非空时要求请求头 `Authorization: Bearer <apiKey>`。 */
  readonly apiKey: string;
  /** 对外暴露的模型 id，默认 'dsh-agent'。 */
  readonly modelId: string;
  readonly logger: (message: string, ...args: unknown[]) => void;
  /** 把一段用户文本交给 DSH agent，返回回复文本。 */
  readonly handleCompletion: (userKey: string, text: string, stream: boolean) => Promise<string>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Bridge {
  private server: Server | undefined;

  constructor(private readonly options: BridgeOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch((err: unknown) => {
          this.sendError(res, err);
        });
      });
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    // 强制关闭 keep-alive / SSE 挂起连接，保证卸载不卡住
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (
      method === 'GET' &&
      (url.pathname === '/v1/models' || url.pathname === '/models')
    ) {
      if (!this.authorized(req)) {
        this.sendJson(res, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } });
        return;
      }
      this.sendJson(res, 200, {
        object: 'list',
        data: [
          {
            id: this.options.modelId,
            object: 'model',
            created: 0,
            owned_by: 'dsh-plugin-wechat',
          },
        ],
      });
      return;
    }

    if (
      method === 'POST' &&
      (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')
    ) {
      await this.handleCompletions(req, res);
      return;
    }

    this.sendJson(res, 404, { error: { message: 'Not found', type: 'not_found_error' } });
  }

  private async handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      this.sendJson(res, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      this.sendJson(res, 400, {
        error: {
          message: `Invalid request body: ${(err as Error).message}`,
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const stream = body.stream === true;
    const extracted = extractUserTextAndId(body.messages);
    const userKey =
      (typeof body.user === 'string' && body.user.trim()) ||
      extracted.chatId ||
      'default';
    const text = extracted.text;
    if (!text) {
      // 图片/语音/文件等无文本消息：返回友好提示，而不是把错误抛回微信
      this.options.logger('received non-text message (image/voice/file), replying with a hint');
      const hint = '（暂时只能处理文字消息，图片/语音/文件暂不支持）';
      if (stream) {
        this.sendSse(res, `chatcmpl-${randomUUID()}`, Math.floor(Date.now() / 1000), hint);
      } else {
        this.sendJson(res, 200, {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: this.options.modelId,
          choices: [
            { index: 0, message: { role: 'assistant', content: hint }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      return;
    }

    let reply: string;
    try {
      reply = await this.options.handleCompletion(userKey, text, stream);
    } catch (err) {
      this.options.logger('agent request failed:', err);
      this.sendJson(res, 500, {
        error: { message: (err as Error).message, type: 'agent_error' },
      });
      return;
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    if (stream) {
      this.sendSse(res, id, created, reply);
    } else {
      this.sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: this.options.modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.options.apiKey) return true;
    return req.headers.authorization === `Bearer ${this.options.apiKey}`;
  }

  /** SSE：一次性输出整段文本的 delta，然后 [DONE]。 */
  private sendSse(res: ServerResponse, id: string, created: number, text: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.options.modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    });
    chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.options.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : 500;
    this.sendJson(res, status, {
      error: { message: (err as Error).message ?? String(err), type: 'server_error' },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 取 messages 里最后一条带文本的 user 消息，并提取其中的微信 chat_id。
 * 兼容 string 与 blocks 数组两种 content。
 *
 * 说明：OpenClaw 转发请求时通常不携带顶层 `user` 字段，而是把微信发送者身份
 * 放在消息文本的「Conversation info (untrusted metadata)」JSON 里的 chat_id 中；
 * 这里把它提取出来作为会话隔离键，避免所有微信好友挤进同一个 `default` 会话。
 */
function extractUserTextAndId(messages: unknown): { text?: string; chatId?: string } {
  const result: { text?: string; chatId?: string } = {};
  if (!Array.isArray(messages)) return result;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== 'user') continue;
    const raw = textOfContent(message.content);
    if (!raw) continue;
    const parsed = parseOpenclawWrapper(raw);
    // 只取第一个（最后一条）非空 user 文本
    if (!result.text && parsed.text) result.text = parsed.text;
    if (!result.chatId && parsed.chatId) result.chatId = parsed.chatId;
    if (result.text && result.chatId) break;
  }
  return result;
}

/** 从 string 或 blocks 数组提取纯文本。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { text?: unknown } | null;
        return typeof b?.text === 'string' ? b.text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * 拆解 OpenClaw 注入的会话元数据包装，返回真实消息文本与微信 chat_id。
 *
 * OpenClaw 转发微信消息时会包装成：
 *   "[时间] Conversation info (untrusted metadata):\n```json\n{..., "chat_id": "xxx@im.wechat"}\n```\n\n<真实消息>"
 * 若不剥离，DSH agent 会把元数据当用户输入，导致回复串味、变慢；
 * 而 chat_id 正是微信发送者的稳定身份，用于按人隔离会话。
 */
function parseOpenclawWrapper(text: string): { text: string; chatId?: string } {
  const marker = 'Conversation info (untrusted metadata):';
  const idx = text.indexOf(marker);
  if (idx === -1) return { text: text.trim() };

  const after = text.slice(idx + marker.length);
  const fence = after.indexOf('```');
  if (fence === -1) return { text: text.trim() };
  const closeFence = after.indexOf('```', fence + 3);
  const jsonStr = fence !== -1 && closeFence !== -1 ? after.slice(fence + 3, closeFence) : '';
  let chatId: string | undefined;
  if (jsonStr) {
    try {
      const meta = JSON.parse(jsonStr) as { chat_id?: unknown };
      if (typeof meta.chat_id === 'string' && meta.chat_id) chatId = meta.chat_id;
    } catch {
      // 元数据解析失败则忽略，仍剥离包装
    }
  }
  const realText = closeFence !== -1 ? after.slice(closeFence + 3).trim() : text.trim();
  return { text: realText, chatId };
}
