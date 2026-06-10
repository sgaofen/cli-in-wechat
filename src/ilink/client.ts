import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { generateWechatUin, encryptAesEcb, aesEcbPaddedSize, encodeMessageAesKey, md5 } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { fetchWithRetry, describeNetworkError, isRetryableNetworkError } from '../utils/http.js';
import { savePollCursor, loadPollCursor, saveContextTokens } from '../config.js';
import { downloadImage, downloadFile, downloadVideo, type DownloadedMedia } from '../utils/media.js';
import type {
  Credentials,
  WeixinMessage,
  GetUpdatesResponse,
  MessageItem,
  GetConfigResponse,
} from './types.js';

const CHANNEL_VERSION = '1.0.2';
const HTTP_TIMEOUT_MS = 45_000;
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const REGULAR_RETRY_DELAYS_MS = [0, 30_000, 60_000, 120_000] as const;
const INTERMEDIATE_RETRY_DELAYS_MS = [0, 12_000] as const;
const BASE_RATE_LIMIT_COOLDOWN_MS = 150_000; // ~2.5 minutes
const MAX_RATE_LIMIT_COOLDOWN_MS = 420_000; // ~7 minutes

// Upload media types
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;

type SendStreamType = 'regular' | 'intermediate';

interface UserRateLimitState {
  consecutiveRet2: number;
  suppressIntermediateUntil: number;
  blockAllSendsUntil: number;
}

export type MessageHandler = (
  msg: WeixinMessage,
  text: string,
  refText: string,
  media?: DownloadedMedia[]
) => void;

export class ILinkClient {
  private credentials: Credentials;
  private pollCursor: string;
  private running = false;
  private contextTokens = new Map<string, string>();
  private typingTickets = new Map<string, { ticket: string; ts: number }>();
  private handlers: MessageHandler[] = [];
  private sendQueues = new Map<string, Promise<void>>();
  private rateLimitStates = new Map<string, UserRateLimitState>();
  private backoffMs = 1000;
  private abortController: AbortController | null = null;
  private consecutiveFailures = 0;
  private longPollTimeoutMs = HTTP_TIMEOUT_MS;
  private reloginInFlight = false;
  private onReloginNeeded?: () => Promise<Credentials | null>;
  // Bounded de-dup of messages: the long-poll cursor can re-deliver a message
  // (at-least-once), and re-running a CLI command twice is harmful. Keyed per-user
  // (from_user_id:message_id) so we never collide across conversations.
  private seenMsgIds = new Set<string>();
  private seenMsgOrder: string[] = [];

  constructor(credentials: Credentials) {
    this.credentials = credentials;
    this.pollCursor = loadPollCursor();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Optional self-heal: invoked when the session expires (errcode -14/-13). Should
   *  re-run the QR login, persist the new credentials, and return them — the poll loop
   *  then swaps them in and continues instead of killing the whole process. */
  setReloginHandler(handler: () => Promise<Credentials | null>): void {
    this.onReloginNeeded = handler;
  }

  updateCredentials(credentials: Credentials): void {
    this.credentials = credentials;
  }

  /** First-seen check for a (user, message) pair; records it (bounded) and returns false
   *  on replay. Composite-keyed so two users never collide on the same numeric id. */
  private isFreshMessage(userId: string, id: number): boolean {
    const key = `${userId}:${id}`;
    if (this.seenMsgIds.has(key)) return false;
    this.seenMsgIds.add(key);
    this.seenMsgOrder.push(key);
    if (this.seenMsgOrder.length > 1000) {
      const evict = this.seenMsgOrder.shift();
      if (evict !== undefined) this.seenMsgIds.delete(evict);
    }
    return true;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.credentials.botToken}`,
      'X-WECHAT-UIN': generateWechatUin(),
    };
  }

  private baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  // ─── Lifecycle ─────────────────────────────────────────

  start(): void {
    this.running = true;
    log.info('iLink 消息轮询已启动');
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info('iLink 消息轮询已停止');
  }

  // ─── Long-polling loop ─────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const msgs = await this.getUpdates();
        this.backoffMs = 1000;
        this.consecutiveFailures = 0;

        for (const msg of msgs) {
          await this.processMessage(msg);
        }
      } catch (err: unknown) {
        if (!this.running) return;

        const error = err as { name?: string; errcode?: number; message?: string };

        if (error.name === 'AbortError') {
          continue; // normal long-poll timeout, not a failure
        }

        if (error.errcode === -14 || error.errcode === -13) {
          if (await this.handleSessionExpired()) continue;
          // Keep running either way (never silently kill the process), but give advice that
          // matches reality: only point at manual re-login when there is no relogin handler.
          if (!this.onReloginNeeded) {
            log.error('会话已过期。请删除 ~/.wx-ai-bridge/credentials.json 后重启以重新登录。');
          } else {
            log.warn('自动重新登录未成功，将在稍后重试…');
          }
          await sleep(30_000);
          continue;
        }

        this.consecutiveFailures += 1;
        // Surface a loud, actionable diagnostic once the loop has been failing for a while
        // (issue #18 class): a steady stream of generic '轮询错误' hides the real cause.
        if (this.consecutiveFailures === 5 || this.consecutiveFailures % 20 === 0) {
          if (isRetryableNetworkError(err)) {
            log.error(`轮询持续失败 ${this.consecutiveFailures} 次:`);
            log.error(describeNetworkError(err));
          } else {
            log.error(`轮询持续失败 ${this.consecutiveFailures} 次:`, error.message || err);
          }
        } else {
          log.error('轮询错误:', error.message || err);
        }

        // Exponential backoff with full jitter, capped at 30s.
        const jittered = Math.floor(this.backoffMs * (0.5 + Math.random() * 0.5));
        await sleep(jittered);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    }
  }

  /** Drive the optional relogin handler exactly once at a time. Returns true if the
   *  session was refreshed (caller should continue the loop). */
  private async handleSessionExpired(): Promise<boolean> {
    if (!this.onReloginNeeded || this.reloginInFlight) return false;
    this.reloginInFlight = true;
    try {
      log.warn('会话已过期，正在尝试重新登录…');
      const creds = await this.onReloginNeeded();
      if (creds) {
        this.credentials = creds;
        this.consecutiveFailures = 0;
        this.backoffMs = 1000;
        log.info('重新登录成功，继续运行');
        return true;
      }
      return false;
    } catch (err) {
      log.error('自动重新登录失败:', (err as Error).message);
      return false;
    } finally {
      this.reloginInFlight = false;
    }
  }

  private async getUpdates(): Promise<WeixinMessage[]> {
    // Keep the manual long-poll deadline: when it fires it aborts the controller, which
    // fetchWithRetry surfaces as an AbortError (NOT retried) so pollLoop treats it as a
    // normal long-poll timeout. Genuine transient drops (ECONNRESET) within the window
    // are retried by fetchWithRetry. The per-attempt timeout is a backstop set above the
    // manual deadline so the manual abort always wins the race.
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), this.longPollTimeoutMs);

    try {
      const res = await fetchWithRetry(
        `${this.credentials.baseUrl}/ilink/bot/getupdates`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            get_updates_buf: this.pollCursor,
            base_info: this.baseInfo(),
          }),
          signal: this.abortController.signal,
          label: 'getupdates',
          retries: 2,
          retryOnHttpError: true,
          timeoutMs: this.longPollTimeoutMs + 15_000,
        },
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as GetUpdatesResponse;

      // API omits ret/errcode on success; only check when explicitly present and non-zero
      if (data.ret !== undefined && data.ret !== 0) {
        const e: Error & { errcode?: number } = new Error(
          data.errmsg || `ret=${data.ret}`,
        );
        e.errcode = data.errcode;
        throw e;
      }

      // Honor the server-suggested long-poll window for the next round (clamped sanely),
      // instead of always assuming the hardcoded 45s.
      const serverMs = data.longpolling_timeout_ms;
      if (typeof serverMs === 'number' && Number.isFinite(serverMs) && serverMs > 0) {
        this.longPollTimeoutMs = Math.min(120_000, Math.max(10_000, serverMs + 5_000));
      }

      if (data.get_updates_buf) {
        this.pollCursor = data.get_updates_buf;
        savePollCursor(this.pollCursor);
      }

      return data.msgs || [];
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Message handling ──────────────────────────────────

  private async processMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages, skip bot echoes
    if (msg.message_type !== 1) return;

    // Drop long-poll re-deliveries so a command is never executed twice (at-most-once).
    if (!this.isFreshMessage(msg.from_user_id, msg.message_id)) {
      log.debug(`[msg] 跳过重复消息 message_id=${msg.message_id}`);
      return;
    }

    // Cache context_token for this user
    this.contextTokens.set(msg.from_user_id, msg.context_token);
    saveContextTokens(this.contextTokens);

    log.debug(`[msg] item_list=${JSON.stringify(redactSecrets(msg.item_list))}`);
    const { text, refText, mediaItems } = await parseMessage(msg);
    if (!text && !refText && mediaItems.length === 0) return;

    log.debug(`收到 [${msg.from_user_id.substring(0, 12)}...]: ${text.substring(0, 60)}${mediaItems.length > 0 ? ` (+${mediaItems.length} media)` : ''}`);

    for (const handler of this.handlers) {
      try {
        handler(msg, text, refText, mediaItems.length > 0 ? mediaItems : undefined);
      } catch (err) {
        log.error('消息处理器异常:', err);
      }
    }
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  // ─── Sending ───────────────────────────────────────────

  private enqueueSend(userId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.sendQueues.get(userId) || Promise.resolve();
    const run = prev.then(task, task);
    const tracked = run.catch(() => {});
    this.sendQueues.set(userId, tracked);
    return run.finally(() => {
      if (this.sendQueues.get(userId) === tracked) {
        this.sendQueues.delete(userId);
      }
    });
  }

  private getRateLimitState(userId: string): UserRateLimitState {
    const state = this.rateLimitStates.get(userId) || {
      consecutiveRet2: 0,
      suppressIntermediateUntil: 0,
      blockAllSendsUntil: 0,
    };
    this.rateLimitStates.set(userId, state);
    return state;
  }

  private isRateLimitedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('ret=-2');
  }

  private nextCooldownMs(consecutiveRet2: number): number {
    // 2nd consecutive ret=-2 => 150s; then linear backoff up to ~7min.
    const steps = Math.max(0, consecutiveRet2 - 2);
    return Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, BASE_RATE_LIMIT_COOLDOWN_MS + steps * 60_000);
  }

  private async gateSendWindow(userId: string, streamType: SendStreamType): Promise<boolean> {
    const state = this.getRateLimitState(userId);
    const now = Date.now();

    if (streamType === 'intermediate' && now < state.suppressIntermediateUntil) {
      log.debug(`[send] 跳过中间消息(保护模式): ${userId.substring(0, 12)}...`);
      return false;
    }

    if (now < state.blockAllSendsUntil) {
      if (streamType === 'intermediate') {
        log.debug('[send] 中间消息命中全局发送冷却，直接跳过');
        return false;
      }
      const waitMs = state.blockAllSendsUntil - now;
      log.warn(`[send] 命中限流冷却窗口，延迟发送 ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }

    return true;
  }

  async sendText(userId: string, text: string, options?: { streamType?: SendStreamType }): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送给 ${userId}: 缺少 context_token (用户必须先发一条消息)`);
      return;
    }
    const streamType = options?.streamType || 'regular';
    if (!(await this.gateSendWindow(userId, streamType))) {
      return;
    }    

    await this.enqueueSend(userId, async () => {
      const chunks = chunkText(text, 2000);
      log.debug(`发送给 [${userId.substring(0, 12)}...] (${chunks.length} 块): ${text.substring(0, 100)}${text.length > 100 ? '…' : ''}`);
      for (let i = 0; i < chunks.length; i++) {
        await this.sendRawMessageWithRetry(userId, token, [
          { type: 1 as const, text_item: { text: chunks[i] } },
        ], streamType);
      }
    });
  }

  private async sendRawMessageWithRetry(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
    streamType: SendStreamType = 'regular',
  ): Promise<void> {
    const state = this.getRateLimitState(userId);
    let lastErr: unknown = null;
    const retryDelays = streamType === 'regular'
      ? REGULAR_RETRY_DELAYS_MS
      : INTERMEDIATE_RETRY_DELAYS_MS;

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      const delay = retryDelays[attempt];
      if (delay > 0) await sleep(delay);

      if (!(await this.gateSendWindow(userId, streamType))) {
        return;
      }

      try {
        await this.sendRawMessage(userId, contextToken, itemList);
        state.consecutiveRet2 = 0;
        state.blockAllSendsUntil = 0;
        return;
      } catch (err) {
        lastErr = err;
        const isRateLimited = this.isRateLimitedError(err);

        if (isRateLimited) {
          state.consecutiveRet2 += 1;
          const cooldownMs = this.nextCooldownMs(state.consecutiveRet2);
          const until = Date.now() + cooldownMs;
          state.blockAllSendsUntil = Math.max(state.blockAllSendsUntil, until);
          state.suppressIntermediateUntil = Math.max(state.suppressIntermediateUntil, until);
          log.warn(`[send] 命中限流 ret=-2，进入冷却 ${Math.round(cooldownMs / 1000)}s (连续${state.consecutiveRet2}次)`);
        }

        if (!isRateLimited || attempt === retryDelays.length - 1) {
          throw err;
        }
        log.warn(`[send] ret=-2 延迟重试 (${attempt + 1}/${retryDelays.length - 1})`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('发送消息失败');
  }

  private async sendRawMessage(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
  ): Promise<void> {
    const res = await fetchWithRetry(
      `${this.credentials.baseUrl}/ilink/bot/sendmessage`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: userId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: itemList,
          },
          base_info: this.baseInfo(),
        }),
        label: 'send',
        retries: 2,
        timeoutMs: 30_000,
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`发送消息失败: HTTP ${res.status} ${body}`);
    }

    const data = (await res.json()) as { ret?: number; errmsg?: string };
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`发送消息失败: ${data.errmsg || `ret=${data.ret}`}`);
    }
  }

  // ─── File/Image/Video Upload & Send ──────────────────────

  async sendFile(userId: string, filePath: string, title?: string): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送文件给 ${userId}: 缺少 context_token`);
      return;
    }

    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const upload = await this.uploadToCdn(userId, filePath, UPLOAD_MEDIA_TYPE_FILE);
    const fileName = title || basename(filePath);

    await this.enqueueSend(userId, async () => {
      await this.sendRawMessageWithRetry(userId, token, [
        {
          type: 4,
          file_item: {
            file_name: fileName,
            len: String(upload.rawsize),
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
          },
        },
      ]);
    });

    log.info(`[sendFile] 已发送: ${fileName}`);
  }

  async sendImage(userId: string, imagePath: string, caption?: string): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送图片给 ${userId}: 缺少 context_token`);
      return;
    }

    if (!existsSync(imagePath)) {
      throw new Error(`图片不存在: ${imagePath}`);
    }

    if (caption) {
      await this.sendText(userId, caption);
    }

    const upload = await this.uploadToCdn(userId, imagePath, UPLOAD_MEDIA_TYPE_IMAGE);

    await this.enqueueSend(userId, async () => {
      await this.sendRawMessageWithRetry(userId, token, [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
            mid_size: upload.filesize,
          },
        },
      ]);
    });

    log.info(`[sendImage] 已发送图片: ${basename(imagePath)}`);
  }

  async sendVideo(userId: string, videoPath: string): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送视频给 ${userId}: 缺少 context_token`);
      return;
    }

    if (!existsSync(videoPath)) {
      throw new Error(`视频不存在: ${videoPath}`);
    }

    const upload = await this.uploadToCdn(userId, videoPath, UPLOAD_MEDIA_TYPE_VIDEO);

    await this.enqueueSend(userId, async () => {
      await this.sendRawMessageWithRetry(userId, token, [
        {
          type: 5,
          video_item: {
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
            video_size: upload.filesize,
          },
        },
      ]);
    });

    log.info(`[sendVideo] 已发送视频: ${basename(videoPath)}`);
  }

  private async uploadToCdn(
    userId: string,
    filePath: string,
    mediaType: number,
  ): Promise<{ rawsize: number; filesize: number; aeskey: Buffer; downloadParam: string }> {
    const plaintext = readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = md5(plaintext);
    const filesize = aesEcbPaddedSize(rawsize);

    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);

    // Get upload URL from iLink
    const uploadResp = await fetchWithRetry(
      `${this.credentials.baseUrl}/ilink/bot/getuploadurl`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          filekey,
          media_type: mediaType,
          to_user_id: userId,
          rawsize,
          rawfilemd5,
          filesize,
          aeskey: aeskey.toString('hex'),
          no_need_thumb: true,
          base_info: this.baseInfo(),
        }),
        label: 'getuploadurl',
        retries: 2,
        timeoutMs: 30_000,
      },
    );

    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      throw new Error(`获取上传URL失败: HTTP ${uploadResp.status} ${body}`);
    }

    const uploadData = (await uploadResp.json()) as { upload_param?: string };
    const uploadParam = uploadData.upload_param;
    if (!uploadParam) {
      throw new Error('获取上传URL失败: 无 upload_param');
    }

    // Encrypt and upload to CDN
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    log.debug(`[upload] Uploading to CDN: ${rawsize} bytes`);

    const cdnResp = await fetchWithRetry(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      label: 'cdn-upload',
      retries: 2,
      timeoutMs: 60_000, // large files need a longer per-attempt window
    });

    if (!cdnResp.ok) {
      const body = await cdnResp.text().catch(() => '');
      throw new Error(`CDN 上传失败: HTTP ${cdnResp.status} ${body}`);
    }

    const downloadParam = cdnResp.headers.get('x-encrypted-param');
    if (!downloadParam) {
      throw new Error('CDN 上传失败: 无 x-encrypted-param');
    }

    log.debug(`[upload] CDN upload success, downloadParam: ${downloadParam.substring(0, 30)}...`);

    return { rawsize, filesize, aeskey, downloadParam };
  }

  // ─── Typing indicator ─────────────────────────────────

  async startTyping(userId: string): Promise<() => void> {
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return () => {};

    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return () => {};

      await this.sendTypingStatus(userId, ticket, 1).catch(() => {});

      const interval = setInterval(() => {
        this.sendTypingStatus(userId, ticket, 1).catch(() => {});
      }, 5000);

      return () => {
        clearInterval(interval);
        this.sendTypingStatus(userId, ticket, 2).catch(() => {});
      };
    } catch {
      return () => {};
    }
  }

  private async getTypingTicket(
    userId: string,
    contextToken: string,
  ): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && Date.now() - cached.ts < 20 * 3600_000) {
      return cached.ticket;
    }

    const res = await fetchWithRetry(
      `${this.credentials.baseUrl}/ilink/bot/getconfig`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: this.baseInfo(),
        }),
        label: 'getconfig',
        retries: 1,
        timeoutMs: 15_000,
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as GetConfigResponse;
    if (data.ret !== 0 || !data.typing_ticket) return null;

    this.typingTickets.set(userId, {
      ticket: data.typing_ticket,
      ts: Date.now(),
    });
    return data.typing_ticket;
  }

  private async sendTypingStatus(
    userId: string,
    ticket: string,
    status: 1 | 2,
  ): Promise<void> {
    // Fire-and-forget heartbeat (every ~5s); a timeout prevents hung sockets from piling up.
    await fetchWithRetry(`${this.credentials.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: this.baseInfo(),
      }),
      label: 'sendtyping',
      retries: 0,
      timeoutMs: 10_000,
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

const SECRET_KEYS = new Set([
  'aes_key', 'aeskey', 'encrypt_query_param', 'full_url', 'url',
]);

/** Deep-clone a value while masking secret fields by name, so DEBUG logs never leak
 *  media decryption keys / signed CDN URLs that could be replayed. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase())
        ? (typeof v === 'string' && v.length > 0 ? '***' : v)
        : redactSecrets(v);
    }
    return out;
  }
  return value;
}

async function parseMessage(msg: WeixinMessage): Promise<{ text: string; refText: string; mediaItems: DownloadedMedia[] }> {
  const parts: string[] = [];
  let refText = '';
  const mediaItems: DownloadedMedia[] = [];
  
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === 2 && item.image_item) {
      try {
        const media = await downloadImage(item.image_item);
        mediaItems.push(media);
        parts.push(`[图片: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载图片失败:', err);
        parts.push('[图片: 下载失败]');
      }
    } else if (item.type === 3 && item.voice_item?.text) {
      parts.push(item.voice_item.text); // voice-to-text transcription
    } else if (item.type === 4 && item.file_item) {
      try {
        const media = await downloadFile(item.file_item);
        mediaItems.push(media);
        parts.push(`[文件: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载文件失败:', err);
        parts.push('[文件: 下载失败]');
      }
    } else if (item.type === 5 && item.video_item) {
      try {
        const media = await downloadVideo(item.video_item);
        mediaItems.push(media);
        parts.push(`[视频: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载视频失败:', err);
        parts.push('[视频: 下载失败]');
      }
    }
    // Extract quoted message content (WeChat 引用消息)
    const ref = item.ref_msg;
    if (ref) {
      const refItem = ref.message_item;
      if (refItem?.text_item?.text) refText = refItem.text_item.text;
      else if (refItem?.voice_item?.text) refText = refItem.voice_item.text;
      else if (ref.title) refText = ref.title;
      log.debug(`[parseMessage] ref_msg extracted=${JSON.stringify(refText.substring(0, 80))}`);
    }
  }
  // WeChat embeds quoted content inline as "[引用]:\n<content>" — strip the prefix
  const text = parts.join('\n').trim().replace(/^\[引用\]:\n?/, '');
  return { text, refText, mediaItems };
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try breaking at paragraph, then line, then space
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    chunks.push(remaining.substring(0, idx));
    remaining = remaining.substring(idx).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
