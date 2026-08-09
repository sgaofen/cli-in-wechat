import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { generateWechatUin, encryptAesEcb, aesEcbPaddedSize, encodeMessageAesKey, md5 } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { fetchWithRetry, describeNetworkError, isRetryableNetworkError } from '../utils/http.js';
import {
  DATA_DIR,
  DEFAULT_MAX_RESPONSE_CHUNK_BYTES,
  atomicWrite,
  savePollCursor,
  loadPollCursor,
  loadContextTokens,
  saveContextTokens,
} from '../config.js';
import { downloadImage, downloadFile, downloadVideo, type DownloadedMedia } from '../utils/media.js';
import type {
  Credentials,
  WeixinMessage,
  GetUpdatesResponse,
  MessageItem,
  GetConfigResponse,
} from './types.js';
import { chunkUtf8Text } from './text-chunk.js';
import { planDeliveryWindow, type DeliveryItem } from './delivery-planner.js';
import { OutboxStore, type OutboxItem } from './outbox.js';
import { QuotaManager } from './quota.js';
import { classifyApiFailure, type ApiErrorDetails, type SendResult } from './send-result.js';
import { DeliveryDiagnostics } from './diagnostics.js';

const CHANNEL_VERSION = '1.0.2';
const HTTP_TIMEOUT_MS = 45_000;
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const BASE_RATE_LIMIT_COOLDOWN_MS = 150_000; // ~2.5 minutes
const MAX_RATE_LIMIT_COOLDOWN_MS = 420_000; // ~7 minutes

// Upload media types
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;

export type SendStreamType = 'regular' | 'intermediate';

export interface ILinkClientOptions {
  accountId?: string;
  outbox?: OutboxStore;
  quota?: QuotaManager;
  diagnostics?: DeliveryDiagnostics;
  outboxPath?: string;
  quotaPath?: string;
  diagnosticsPath?: string;
  contextTokensPath?: string;
  pollCursorPath?: string;
  maxItemsPerWindow?: number;
  maxTextBytes?: number;
  rateLimitBaseCooldownMs?: number;
  rateLimitMaxCooldownMs?: number;
}

export interface DeliveryStatus {
  quota: ReturnType<QuotaManager['snapshot']>;
  pending: OutboxItem[];
  failed: OutboxItem[];
}

export type DeliveryState = 'READY' | 'SENDING' | 'WAITING_INBOUND' | 'RATE_BACKOFF' | 'PERMANENT_FAILURE';
export interface DeliveryStateSnapshot {
  state: DeliveryState;
  pendingCount: number;
  failedCount: number;
  quota: DeliveryStatus['quota'];
}

export class DeliveryFinalizationError extends Error {
  readonly deliveryConfirmed = true;
  readonly cause: unknown;

  constructor(public readonly itemId: string, cause: unknown) {
    super(`delivery confirmed but local finalization failed for ${itemId}`);
    this.name = 'DeliveryFinalizationError';
    this.cause = cause;
  }
}

export function isDeliveryFinalizationError(err: unknown): err is DeliveryFinalizationError {
  return Boolean(err && typeof err === 'object' && (err as { deliveryConfirmed?: unknown }).deliveryConfirmed === true);
}

export const CONTINUATION_NOTICE = '后续内容已排队，请回复“继续”续发。';
const CONTINUATION_SUFFIX = `\n\n${CONTINUATION_NOTICE}`;

interface UserRateLimitState {
  consecutiveRet2: number;
}

export type MessageHandler = (
  msg: WeixinMessage,
  text: string,
  refText: string,
  media?: DownloadedMedia[]
 ) => void | Promise<void>;

export class ILinkClient {
  private credentials: Credentials;
  private readonly accountId: string;
  private readonly outbox: OutboxStore;
  private readonly quota: QuotaManager;
  private readonly diagnostics: DeliveryDiagnostics;
  private readonly contextTokensPath: string;
  private readonly pollCursorPath: string;
  private readonly maxTextBytes: number;
  private readonly bodyChunkBytes: number;
  private readonly rateLimitBaseCooldownMs: number;
  private readonly rateLimitMaxCooldownMs: number;
  private pollCursor: string;
  private pendingPollCursor?: string;
  private running = false;
  private contextTokens = new Map<string, string>();
  private typingTickets = new Map<string, { ticket: string; ts: number }>();
  private handlers: MessageHandler[] = [];
  private sendQueues = new Map<string, Promise<unknown>>();
  private rateLimitStates = new Map<string, UserRateLimitState>();
  private rateLimitTimers = new Map<string, NodeJS.Timeout>();
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

  constructor(credentials: Credentials, options: ILinkClientOptions = {}) {
    this.credentials = credentials;
    this.accountId = options.accountId || credentials.ilinkBotId || credentials.ilinkUserId || 'default-account';
    this.pollCursorPath = options.pollCursorPath || join(DATA_DIR, 'poll_cursor.txt');
    this.pollCursor = loadPollCursorAt(this.pollCursorPath);
    this.contextTokensPath = options.contextTokensPath || join(DATA_DIR, 'context_tokens.json');
    this.contextTokens = loadContextTokensAt(this.contextTokensPath);
    const minimumTextBytes = Buffer.byteLength(CONTINUATION_SUFFIX, 'utf8') + 1;
    const configuredTextBytes = options.maxTextBytes ?? DEFAULT_MAX_RESPONSE_CHUNK_BYTES;
    this.maxTextBytes = Number.isFinite(configuredTextBytes)
      ? Math.max(minimumTextBytes, Math.floor(configuredTextBytes))
      : DEFAULT_MAX_RESPONSE_CHUNK_BYTES;
    this.bodyChunkBytes = this.maxTextBytes - Buffer.byteLength(CONTINUATION_SUFFIX, 'utf8');
    this.rateLimitBaseCooldownMs = Math.max(0, Math.floor(
      options.rateLimitBaseCooldownMs ?? BASE_RATE_LIMIT_COOLDOWN_MS,
    ));
    this.rateLimitMaxCooldownMs = Math.max(this.rateLimitBaseCooldownMs, Math.floor(
      options.rateLimitMaxCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS,
    ));
    this.quota = options.quota || new QuotaManager(options.quotaPath || join(DATA_DIR, 'quota.json'), this.accountId, {
      maxItemsPerWindow: options.maxItemsPerWindow,
    });
    const maxItemsPerWindow = this.quota.getMaxItemsPerWindow();
    this.outbox = options.outbox || new OutboxStore(options.outboxPath || join(DATA_DIR, 'outbox.json'), {
      bodyChunkBytes: this.bodyChunkBytes,
      inboundItemLimit: maxItemsPerWindow,
    });
    this.diagnostics = options.diagnostics || new DeliveryDiagnostics(
      options.diagnosticsPath || join(DATA_DIR, 'delivery-diagnostics.jsonl'),
      { onError: (error) => log.error('[delivery] 诊断日志已停用:', error) },
    );
    const pendingUsers = new Set(this.outbox.list(undefined, this.accountId).map((item) => item.userId));
    for (const userId of pendingUsers) {
      const until = this.quota.snapshot(userId).rateBackoffUntil;
      if (until > 0) this.scheduleRateLimitRecovery(userId, until);
    }
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

  private forgetMessage(userId: string, id: number): void {
    const key = `${userId}:${id}`;
    if (!this.seenMsgIds.delete(key)) return;
    const index = this.seenMsgOrder.indexOf(key);
    if (index >= 0) this.seenMsgOrder.splice(index, 1);
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
    for (const timer of this.rateLimitTimers.values()) clearTimeout(timer);
    this.rateLimitTimers.clear();
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
        this.commitPendingPollCursor();
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
        this.pendingPollCursor = data.get_updates_buf;
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

    try {
      await this.processFreshMessage(msg);
    } catch (error) {
      this.forgetMessage(msg.from_user_id, msg.message_id);
      this.quota.abandonInbound(msg.from_user_id, msg.message_id);
      throw error;
    }
  }

  private async processFreshMessage(msg: WeixinMessage): Promise<void> {
    const usableContextToken = msg.context_token || this.contextTokens.get(msg.from_user_id) || '';
    const inbound = this.quota.recordInbound(msg.from_user_id, msg.message_id, usableContextToken);
    this.diagnostics.record({
      event: 'inbound',
      userId: msg.from_user_id,
      messageId: msg.message_id,
      generation: inbound.generation,
      tokenVersion: inbound.tokenVersion,
      duplicate: inbound.duplicate,
    });
    // The in-memory de-dup cache is intentionally bounded. The durable quota
    // ledger is the second line of defense after a process restart.
    if (inbound.duplicate) {
      log.debug(`[msg] 跳过已持久化消息 message_id=${msg.message_id}`);
      return;
    }

    // Cache context_token for this user
    if (msg.context_token) this.contextTokens.set(msg.from_user_id, msg.context_token);
    this.persistContextTokens();
    this.outbox.clearRecoveryRequiredForUser(this.accountId, msg.from_user_id);

    log.debug(`[msg] item_list=${JSON.stringify(redactSecrets(msg.item_list))}`);
    const { text, refText, mediaItems } = await parseMessage(msg);

    log.debug(`收到 [${msg.from_user_id.substring(0, 12)}...]: ${text.substring(0, 60)}${mediaItems.length > 0 ? ` (+${mediaItems.length} media)` : ''}`);

    if (!text && !refText && mediaItems.length === 0) {
      this.quota.completeInbound(msg.from_user_id, msg.message_id);
      return;
    }

    for (const handler of this.handlers) {
      try {
        await handler(msg, text, refText, mediaItems.length > 0 ? mediaItems : undefined);
      } catch (err) {
        log.error('消息处理器异常:', err);
        throw err;
      }
    }
    this.quota.completeInbound(msg.from_user_id, msg.message_id);
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  private commitPendingPollCursor(): void {
    if (!this.pendingPollCursor) return;
    this.pollCursor = this.pendingPollCursor;
    this.pendingPollCursor = undefined;
    if (this.pollCursorPath === join(DATA_DIR, 'poll_cursor.txt')) {
      savePollCursor(this.pollCursor);
    } else {
      mkdirSync(dirname(this.pollCursorPath), { recursive: true });
      atomicWrite(this.pollCursorPath, this.pollCursor);
    }
  }

  private persistContextTokens(): void {
    if (this.contextTokensPath === join(DATA_DIR, 'context_tokens.json')) {
      saveContextTokens(this.contextTokens);
      return;
    }
    mkdirSync(dirname(this.contextTokensPath), { recursive: true });
    const values: Record<string, string> = {};
    for (const [userId, token] of this.contextTokens) values[userId] = token;
    atomicWrite(this.contextTokensPath, JSON.stringify(values, null, 2));
  }

  // ─── Sending ───────────────────────────────────────────

  private enqueueSend<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(userId) || Promise.resolve();
    const run = prev.then(task, task);
    const tracked = run.then(() => undefined, () => undefined);
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
    };
    this.rateLimitStates.set(userId, state);
    return state;
  }

  private nextCooldownMs(consecutiveRet2: number): number {
    // 2nd consecutive ret=-2 => 150s; then linear backoff up to ~7min.
    const steps = Math.max(0, consecutiveRet2 - 2);
    return Math.min(this.rateLimitMaxCooldownMs, this.rateLimitBaseCooldownMs + steps * 60_000);
  }

  private scheduleRateLimitRecovery(userId: string, until: number): void {
    const current = this.rateLimitTimers.get(userId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.rateLimitTimers.delete(userId);
      try { this.quota.clearRateBackoff(userId); } catch (error) {
        log.error('[delivery] 无法清除限流状态:', error);
        return;
      }
      void this.recoverPending(userId).catch((error) => {
        log.error('[delivery] 限流到期自动续发失败:', error);
      });
    }, Math.max(0, until - Date.now()));
    timer.unref?.();
    this.rateLimitTimers.set(userId, timer);
  }

  private resetRateLimitState(userId: string): void {
    const state = this.getRateLimitState(userId);
    state.consecutiveRet2 = 0;
    const timer = this.rateLimitTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.rateLimitTimers.delete(userId);
    try { this.quota.clearRateBackoff(userId); } catch (error) {
      log.warn('[delivery] 已发送，但无法清除持久限流状态:', error);
    }
  }

  async sendText(userId: string, text: string, options?: {
    streamType?: SendStreamType;
    priority?: OutboxItem['priority'];
    generation?: number;
  }): Promise<SendResult[]> {
    const streamType = options?.streamType || 'regular';
    return this.enqueueSend(userId, async () => {
      const snapshot = this.quota.snapshot(userId);
      const chunks = chunkUtf8Text(text, this.bodyChunkBytes);
      const priority = options?.priority || (streamType === 'intermediate' ? 'intermediate' as const : 'final' as const);
      const generation = options?.generation ?? snapshot.generation;
      const items = this.outbox.enqueueTextBatch(chunks.map((chunk) => ({
          accountId: this.accountId,
          userId,
          generation,
          tokenVersion: snapshot.tokenVersion,
          priority,
          text: chunk,
        })));
      for (const item of items) {
        this.diagnostics.record({
          event: 'queue-enqueue',
          userId,
          itemId: item.itemId,
          generation: item.generation,
          tokenVersion: item.tokenVersion,
          priority: item.priority,
          bytes: item.bytes,
        });
      }
      log.debug(`发送给 [${userId.substring(0, 12)}...] (${chunks.length} 块): ${text.substring(0, 100)}${text.length > 100 ? '…' : ''}`);

      if (!this.contextTokens.get(userId)) {
        log.error(`无法发送给 ${userId}: 缺少 context_token (用户必须先发一条消息)`);
        return items.map((item) => this.resultForItem(item, 'waiting-for-token'));
      }
      return this.deliverPendingNow(userId);
    });
  }

  async recoverPending(userId: string): Promise<SendResult[]> {
    return this.enqueueSend(userId, () => this.deliverPendingNow(userId));
  }

  getDeliveryState(userId: string): DeliveryStateSnapshot {
    const status = this.getDeliveryStatus(userId);
    let state: DeliveryState = 'READY';
    if (status.failed.length > 0) state = 'PERMANENT_FAILURE';
    else if (status.quota.rateBackoffUntil > Date.now()) state = 'RATE_BACKOFF';
    else if (this.sendQueues.has(userId)) state = 'SENDING';
    else if (
      status.pending.some((item) => item.recoveryRequired)
      || (status.pending.length > 0
        && (status.quota.generation === 0 || status.quota.remainingItems === 0 || !this.contextTokens.get(userId)))
    ) {
      state = 'WAITING_INBOUND';
    }
    return {
      state,
      pendingCount: status.pending.length,
      failedCount: status.failed.length,
      quota: status.quota,
    };
  }

  getDeliveryStatus(userId: string): DeliveryStatus {
    const all = this.outbox.list(userId, this.accountId);
    return {
      quota: this.quota.snapshot(userId),
      pending: all.filter((item) => item.state === 'pending'),
      failed: all.filter((item) => item.state === 'permanent-failure'),
    };
  }

  private reconcileDeliveryReceipts(userId: string): void {
    const confirmed = this.outbox.listPending(userId, this.accountId)
      .filter((item) => item.deliveryReceipt);
    for (const item of confirmed) {
      const receipt = item.deliveryReceipt!;
      this.quota.commitDelivery({
        reservationId: receipt.reservationId,
        userId,
        itemId: item.itemId,
        quotaGeneration: receipt.quotaGeneration,
        bytes: item.bytes,
      });
      this.outbox.ack(item.itemId);
      this.diagnostics.record({ event: 'ack', userId, itemId: item.itemId, bytes: item.bytes });
    }
  }

  private async deliverPendingNow(userId: string): Promise<SendResult[]> {
    this.reconcileDeliveryReceipts(userId);
    const pending = this.outbox.listPending(userId, this.accountId);
    if (pending.length === 0) return [];
    if (pending.some((item) => item.recoveryRequired)) {
      return pending.map((item) => this.resultForItem(
        item,
        item.recoveryRequired ? 'ambiguous' : 'queued',
        item.terminalError,
      ));
    }

    const token = this.contextTokens.get(userId);
    if (!token) return pending.map((item) => this.resultForItem(item, 'waiting-for-token'));

    const snapshot = this.quota.snapshot(userId);
    if (snapshot.generation === 0) return pending.map((item) => this.resultForItem(item, 'waiting-for-token'));
    if (snapshot.remainingItems === 0) return pending.map((item) => this.resultForItem(item, 'queued'));
    if (snapshot.rateBackoffUntil > Date.now()) {
      return pending.map((item) => this.resultForItem(item, 'rate-limited', {
        errmsg: 'rate limited; waiting for the next inbound window',
      }));
    }

    const plan = planDeliveryWindow(pending as DeliveryItem[], {
      sentItems: snapshot.sentItems,
      maxItems: snapshot.sentItems + snapshot.remainingItems,
      maxItemsByPriority: this.quota.maxItemsByPriority(),
      maxBytes: this.maxTextBytes,
      continuationNotice: CONTINUATION_NOTICE,
    });
    this.diagnostics.record({
      event: 'plan',
      userId,
      generation: snapshot.generation,
      tokenVersion: snapshot.tokenVersion,
      sentItems: snapshot.sentItems,
      plannedItems: plan.items.length,
      remainingItems: plan.remainingItems,
      needsContinuation: plan.needsContinuation,
    });
    const results: SendResult[] = [];

    for (const planned of plan.items) {
      const current = this.outbox.get(planned.itemId);
      if (!current) continue;
      const frozen = this.outbox.freezeText(
        current.itemId,
        planned.text,
        Boolean(planned.continuationNoticeAttached),
      ) || current;
      const reserved = this.quota.reserve(userId, frozen.bytes, frozen.priority, {
        generation: frozen.generation,
        tokenVersion: frozen.tokenVersion,
      });
      if (!reserved.allowed) {
        results.push(this.resultForItem(frozen, 'queued', { errmsg: reserved.reason }));
        break;
      }
      const reservationId = reserved.reservation.reservationId;
      try {
        this.diagnostics.record({
          event: 'request',
          userId,
          itemId: frozen.itemId,
          clientId: frozen.clientId,
          generation: frozen.generation,
          bytes: frozen.bytes,
        });
        await this.sendRawTextMessage(userId, token, frozen);
        this.diagnostics.record({
          event: 'response',
          userId,
          itemId: frozen.itemId,
          clientId: frozen.clientId,
          ret: 0,
        });
      } catch (err) {
        this.quota.release(reservationId);
        const details = errorDetails(err);
        this.diagnostics.record({
          event: 'response',
          userId,
          itemId: frozen.itemId,
          clientId: frozen.clientId,
          ret: details.ret,
          errcode: details.errcode,
          errmsg: details.errmsg,
          httpStatus: details.httpStatus,
        });
        const classified = classifyApiFailure(details);
        if (classified?.status === 'rate-limited') {
          const cooldownMs = this.nextCooldownMs(this.getRateLimitState(userId).consecutiveRet2 + 1);
          this.getRateLimitState(userId).consecutiveRet2 += 1;
          const until = this.quota.markRateBackoff(userId, cooldownMs);
          this.scheduleRateLimitRecovery(userId, until);
          this.outbox.freezeText(
            current.itemId,
            current.text,
            Boolean(current.continuationNoticeAttached),
          );
          results.push(this.resultForItem(frozen, 'rate-limited', details));
        } else if (classified?.status === 'permanent-failure') {
          this.outbox.markPermanentFailure(frozen.itemId, details);
          results.push(this.resultForItem(frozen, 'permanent-failure', details));
        } else {
          this.outbox.markAmbiguous(frozen.itemId, details);
          results.push(this.resultForItem(frozen, 'ambiguous', details));
        }
        break;
      }

      try {
        if (!this.outbox.recordDeliveryReceipt(frozen.itemId, reservationId, snapshot.generation)) {
          this.quota.release(reservationId);
          throw new Error(`failed to persist delivery receipt for ${frozen.itemId}`);
        }
        if (!this.quota.commitDelivery({
          reservationId,
          userId,
          itemId: frozen.itemId,
          quotaGeneration: snapshot.generation,
          bytes: frozen.bytes,
        })) {
          const currentGeneration = this.quota.snapshot(userId).generation;
          log.warn(`[delivery] 配额窗口在确认期间从 ${snapshot.generation} 前进到 ${currentGeneration}; 已确认消息保持 ack`);
        }
        this.outbox.ack(frozen.itemId);
        this.diagnostics.record({ event: 'ack', userId, itemId: frozen.itemId, bytes: frozen.bytes });
        this.resetRateLimitState(userId);
      } catch (err) {
        throw isDeliveryFinalizationError(err) ? err : new DeliveryFinalizationError(frozen.itemId, err);
      }
      results.push(this.resultForItem(frozen, 'sent'));
    }
    return results;
  }

  private resultForItem(item: OutboxItem, status: SendResult['status'], error?: ApiErrorDetails): SendResult {
    return {
      status,
      itemId: item.itemId,
      userId: item.userId,
      generation: item.generation,
      tokenVersion: item.tokenVersion,
      attemptedBytes: item.bytes,
      ...(error ? { error } : {}),
    };
  }

  private async sendRawTextMessage(userId: string, contextToken: string, item: OutboxItem): Promise<void> {
    let res: Response;
    try {
      res = await fetchWithRetry(
        `${this.credentials.baseUrl}/ilink/bot/sendmessage`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            msg: {
              from_user_id: '',
              to_user_id: userId,
              client_id: item.clientId,
              message_type: 2,
              message_state: 2,
              context_token: contextToken,
              item_list: [{ type: 1 as const, text_item: { text: item.text } }],
            },
            base_info: this.baseInfo(),
          }),
          label: 'send-text',
          retries: 0,
          timeoutMs: 30_000,
        },
      );
    } catch (err) {
      throw new ILinkApiError({ errmsg: err instanceof Error ? err.message : String(err) });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ILinkApiError({ httpStatus: res.status, errmsg: `HTTP ${res.status} ${body}` });
    }

    const raw = await res.text().catch(() => '');
    if (!raw.trim()) throw new ILinkApiError({ httpStatus: res.status, errmsg: 'empty sendmessage response' });
    let data: { ret?: number; errcode?: number; errmsg?: string; message_id?: number | string };
    try {
      data = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string; message_id?: number | string };
    } catch {
      throw new ILinkApiError({ httpStatus: res.status, errmsg: 'sendmessage response was not valid JSON' });
    }
    if (data.ret !== undefined && data.ret !== 0) {
      throw new ILinkApiError({ ret: data.ret, errcode: data.errcode, errmsg: data.errmsg || `ret=${data.ret}` });
    }
    if (data.ret !== 0 && data.message_id === undefined) {
      throw new ILinkApiError({ httpStatus: res.status, errmsg: 'sendmessage response did not confirm delivery' });
    }
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
        label: 'send-media',
        retries: 0,
        timeoutMs: 30_000,
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ILinkApiError({ httpStatus: res.status, errmsg: `HTTP ${res.status} ${body}` });
    }

    const raw = await res.text().catch(() => '');
    if (!raw.trim()) {
      throw new ILinkApiError({ httpStatus: res.status, errmsg: 'empty sendmessage response' });
    }
    let data: { ret?: number; errcode?: number; errmsg?: string; message_id?: number | string };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new ILinkApiError({ httpStatus: res.status, errmsg: 'sendmessage response was not valid JSON' });
    }
    if (data.ret !== undefined && data.ret !== 0) {
      throw new ILinkApiError({
        ret: data.ret,
        errcode: data.errcode,
        errmsg: data.errmsg || `ret=${data.ret}`,
      });
    }
    if (data.ret !== 0 && data.message_id === undefined) {
      throw new ILinkApiError({ httpStatus: res.status, errmsg: 'sendmessage response did not confirm delivery' });
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

    const fileName = title || basename(filePath);
    await this.withMediaBudget(userId, async () => {
      const upload = await this.uploadToCdn(userId, filePath, UPLOAD_MEDIA_TYPE_FILE);
      return [
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
      ];
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

    await this.withMediaBudget(userId, async () => {
      const upload = await this.uploadToCdn(userId, imagePath, UPLOAD_MEDIA_TYPE_IMAGE);
      return [
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
      ];
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

    await this.withMediaBudget(userId, async () => {
      const upload = await this.uploadToCdn(userId, videoPath, UPLOAD_MEDIA_TYPE_VIDEO);
      return [
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
      ];
    });

    log.info(`[sendVideo] 已发送视频: ${basename(videoPath)}`);
  }

  private async withMediaBudget(userId: string, prepare: () => Promise<MessageItem[]>): Promise<void> {
    return this.enqueueSend(userId, async () => {
      await this.deliverPendingNow(userId);
      if (this.outbox.listPending(userId, this.accountId).length > 0) {
        throw new Error('media send blocked: text delivery backlog must be drained first');
      }

      const preflightSnapshot = this.quota.snapshot(userId);
      if (preflightSnapshot.rateBackoffUntil > Date.now()) {
        this.scheduleRateLimitRecovery(userId, preflightSnapshot.rateBackoffUntil);
        throw new Error('media send blocked: delivery window is rate limited');
      }
      const preflight = this.quota.reserve(userId, 0, 'media', {
        generation: preflightSnapshot.generation,
        tokenVersion: preflightSnapshot.tokenVersion,
      });
      if (!preflight.allowed) {
        throw new Error(`media send blocked by quota budget: ${preflight.reason}`);
      }
      this.quota.release(preflight.reservation.reservationId);

      const itemList = await prepare();
      const token = this.contextTokens.get(userId);
      if (!token) throw new Error('media send blocked: missing context token');
      const snapshot = this.quota.snapshot(userId);
      const reserved = this.quota.reserve(userId, 0, 'media', {
        generation: snapshot.generation,
        tokenVersion: snapshot.tokenVersion,
      });
      if (!reserved.allowed) {
        throw new Error(`media send blocked by quota budget: ${reserved.reason}`);
      }

      const reservationId = reserved.reservation.reservationId;
      try {
        await this.sendRawMessage(userId, token, itemList);
      } catch (error) {
        const details = errorDetails(error);
        const classified = classifyApiFailure(details);
        if (classified?.status === 'rate-limited') {
          this.quota.release(reservationId);
          const state = this.getRateLimitState(userId);
          state.consecutiveRet2 += 1;
          const until = this.quota.markRateBackoff(userId, this.nextCooldownMs(state.consecutiveRet2));
          this.scheduleRateLimitRecovery(userId, until);
        } else if (classified?.ambiguous) {
          this.quota.commit(reservationId);
        } else {
          this.quota.release(reservationId);
        }
        throw error;
      }

      if (!this.quota.commit(reservationId)) {
        this.quota.confirmSend(userId, `media:${reservationId}`);
      }
      this.resetRateLimitState(userId);
    });
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

class ILinkApiError extends Error {
  constructor(public readonly details: ApiErrorDetails) {
    super(details.errmsg || `iLink send failed${details.ret === undefined ? '' : ` ret=${details.ret}`}`);
    this.name = 'ILinkApiError';
  }
}

function errorDetails(error: unknown): ApiErrorDetails {
  if (error instanceof ILinkApiError) return error.details;
  const details = (error as { details?: ApiErrorDetails } | null)?.details;
  if (details) return details;
  return { errmsg: error instanceof Error ? error.message : String(error) };
}

function loadContextTokensAt(filePath: string): Map<string, string> {
  if (filePath === join(DATA_DIR, 'context_tokens.json')) return loadContextTokens();
  if (!existsSync(filePath)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return new Map();
  }
}

function loadPollCursorAt(filePath: string): string {
  if (filePath === join(DATA_DIR, 'poll_cursor.txt')) return loadPollCursor();
  if (!existsSync(filePath)) return '';
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
