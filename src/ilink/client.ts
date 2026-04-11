import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { generateWechatUin, encryptAesEcb, aesEcbPaddedSize, encodeMessageAesKey, md5 } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
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

// Upload media types
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;

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
  private backoffMs = 1000;
  private abortController: AbortController | null = null;

  constructor(credentials: Credentials) {
    this.credentials = credentials;
    this.pollCursor = loadPollCursor();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
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

        for (const msg of msgs) {
          await this.processMessage(msg);
        }
      } catch (err: unknown) {
        if (!this.running) return;

        const error = err as { name?: string; errcode?: number; message?: string };

        if (error.name === 'AbortError') {
          continue; // normal timeout
        }

        if (error.errcode === -14 || error.errcode === -13) {
          log.error('会话已过期，需要重新登录 (删除 ~/.wx-ai-bridge/credentials.json 后重启)');
          this.running = false;
          return;
        }

        log.error('轮询错误:', error.message || err);
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    }
  }

  private async getUpdates(): Promise<WeixinMessage[]> {
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), HTTP_TIMEOUT_MS);

    try {
      const res = await fetch(
        `${this.credentials.baseUrl}/ilink/bot/getupdates`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            get_updates_buf: this.pollCursor,
            base_info: this.baseInfo(),
          }),
          signal: this.abortController.signal,
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

    // Cache context_token for this user
    this.contextTokens.set(msg.from_user_id, msg.context_token);
    saveContextTokens(this.contextTokens);

    log.debug(`[msg] item_list=${JSON.stringify(msg.item_list)}`);
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

  async sendText(userId: string, text: string): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送给 ${userId}: 缺少 context_token (用户必须先发一条消息)`);
      return;
    }

    const chunks = chunkText(text, 2000);
    log.debug(`发送给 [${userId.substring(0, 12)}...] (${chunks.length} 块): ${text.substring(0, 100)}${text.length > 100 ? '…' : ''}`);
    for (let i = 0; i < chunks.length; i++) {
      await this.sendRawMessage(userId, token, [
        { type: 1 as const, text_item: { text: chunks[i] } },
      ]);
      if (i < chunks.length - 1) {
        await sleep(300); // preserve ordering between chunks
      }
    }
  }

  private async sendRawMessage(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
  ): Promise<void> {
    const res = await fetch(
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

    await this.sendRawMessage(userId, token, [
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

    await this.sendRawMessage(userId, token, [
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

    await this.sendRawMessage(userId, token, [
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
    const uploadResp = await fetch(
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

    const cdnResp = await fetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
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

    const res = await fetch(
      `${this.credentials.baseUrl}/ilink/bot/getconfig`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: this.baseInfo(),
        }),
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
    await fetch(`${this.credentials.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: this.baseInfo(),
      }),
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

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
