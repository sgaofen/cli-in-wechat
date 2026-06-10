import { writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { log } from './logger.js';
import { fetchWithRetry } from './http.js';
import type { CDNMedia, ImageItem, FileItem, VideoItem } from '../ilink/types.js';
import { parseAesKey } from '../utils/crypto.js';

const GLOBAL_MEDIA_DIR = join(homedir(), '.wx-ai-bridge', 'media');
const WX_CDN_BASE = 'https://multimedia.nt.qq.com.cn';
const WORK_MEDIA_SUBDIR = '.wx-media';

export interface DownloadedMedia {
  type: 'image' | 'file' | 'video';
  path: string;
  fileName: string;
  mimeType?: string;
  size?: number;
}

export function ensureMediaDir(workDir?: string): string {
  const mediaDir = workDir ? join(workDir, WORK_MEDIA_SUBDIR) : GLOBAL_MEDIA_DIR;
  if (!existsSync(mediaDir)) {
    mkdirSync(mediaDir, { recursive: true });
  }
  return mediaDir;
}

export async function downloadMedia(
  media: CDNMedia,
  options: {
    type: 'image' | 'file' | 'video';
    fileName?: string;
    mimeType?: string;
    workDir?: string;
  }
): Promise<DownloadedMedia> {
  const mediaDir = ensureMediaDir(options.workDir);
  
  const { encrypt_query_param, aes_key, encrypt_type, full_url } = media;
  
  log.debug(`[media] encrypt_query_param: ${encrypt_query_param?.substring(0, 100)}...`);
  log.debug(`[media] aes_key: ${aes_key ? 'present' : 'none'}, encrypt_type: ${encrypt_type}, full_url: ${full_url ? 'present' : 'none'}`);
  
  // 优先使用 full_url（文件下载）
  let url: string;
  if (full_url) {
    url = full_url;
    log.debug(`[media] Using full_url for download`);
  } else {
    url = buildCdnUrl(encrypt_query_param);
  }
  
  log.debug(`[media] Downloading from: ${url.substring(0, 100)}...`);
  
  const response = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'MicroMessenger/6.0',
    },
    label: 'media-download',
    retries: 3,
    retryOnHttpError: true, // downloads are idempotent GETs
    timeoutMs: 60_000,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error(`[media] HTTP ${response.status}: ${body.substring(0, 200)}`);
    throw new Error(`Failed to download media: HTTP ${response.status}`);
  }
  
  let data: Buffer = Buffer.from(await response.arrayBuffer());

  // 微信 CDN 下行的媒体多为 AES-128-ECB 加密；c2c CDN 偶尔直返明文。
  // 策略：原始字节若已是已知格式 → 直接保存；否则用 aes_key 做 ECB 解密；
  // 解密结果再次校验 magic，校验失败说明 key/算法不对，宁可写原始字节也别写半解出的乱码。
  const rawFmt = detectFileFormat(data);
  if (rawFmt) {
    log.debug(`[media] Raw response is already ${rawFmt} (${data.length} bytes), skipping decrypt`);
  } else if (aes_key) {
    try {
      const decrypted = decryptMedia(data, aes_key);
      const decFmt = detectFileFormat(decrypted);
      if (decFmt) {
        data = decrypted;
        log.debug(`[media] Decrypted to ${decFmt} (${decrypted.length} bytes)`);
      } else {
        log.warn(`[media] Decrypt produced unrecognized format, keeping raw bytes (file may be unviewable)`);
      }
    } catch (err) {
      log.warn(`[media] Decrypt failed, keeping raw bytes (file may be unviewable): ${err}`);
    }
  } else {
    log.warn(`[media] No aes_key and unrecognized format, saving raw bytes (file may be unviewable)`);
  }
  
  // options.fileName may come straight from an untrusted WeChat file_item.file_name.
  const fileName = safeFileName(options.fileName, options.type);
  const filePath = join(mediaDir, fileName);

  writeFileSync(filePath, data);
  
  log.info(`[media] Saved: ${filePath} (${data.length} bytes)`);
  
  return {
    type: options.type,
    path: filePath,
    fileName,
    mimeType: options.mimeType,
    size: data.length,
  };
}

export async function downloadImage(item: ImageItem, workDir?: string): Promise<DownloadedMedia> {
  const mediaDir = ensureMediaDir(workDir);
  
  // 优先使用 item.url（如果有）
  if (item.url) {
    log.debug(`[media] Using direct URL: ${item.url}`);
    try {
      const response = await fetchWithRetry(item.url, {
        headers: { 'User-Agent': 'MicroMessenger/6.0' },
        label: 'image-url', retries: 2, retryOnHttpError: true, timeoutMs: 60_000,
      });
      if (response.ok) {
        const fileName = extractFileNameFromUrl(item.url);
        const filePath = join(mediaDir, fileName);
        const data = new Uint8Array(await response.arrayBuffer());
        writeFileSync(filePath, data);
        log.info(`[media] Saved from URL: ${filePath} (${data.length} bytes)`);
        return { type: 'image', path: filePath, fileName, size: data.length };
      }
    } catch (err) {
      log.warn(`[media] Direct URL failed, trying CDN: ${err}`);
    }
  }
  
  return downloadMedia(item.media, {
    type: 'image',
    fileName: item.url ? extractFileNameFromUrl(item.url) : undefined,
    workDir,
  });
}

export async function downloadFile(item: FileItem, workDir?: string): Promise<DownloadedMedia> {
  return downloadMedia(item.media, {
    type: 'file',
    fileName: item.file_name,
    workDir,
  });
}

export async function downloadVideo(item: VideoItem, workDir?: string): Promise<DownloadedMedia> {
  return downloadMedia(item.media, {
    type: 'video',
    workDir,
  });
}

function buildCdnUrl(encryptQueryParam: string): string {
  if (encryptQueryParam.startsWith('http')) {
    return encryptQueryParam;
  }
  return `${WX_CDN_BASE}/cdn?${encryptQueryParam}`;
}

function decryptMedia(data: Buffer, aesKeyBase64: string): Buffer {
  // 上传端用 AES-128-ECB + PKCS#7（见 ilink/client.ts uploadToCdn → encryptAesEcb），
  // 因此下载端只需 ECB 解密。原先的 CBC + 全零 IV 回退路径对 ECB 密文必然抛 bad_decrypt，
  // 反而把已成功的 ECB 结果丢掉，是 #16 中文件无法查看的根因之一。
  const key = parseAesKey(aesKeyBase64);
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Detect common media/document file formats by magic bytes.
 * Returns the format name or null if unrecognized.
 * Used to decide whether bytes need AES decryption and whether decryption succeeded.
 */
function detectFileFormat(data: Buffer): string | null {
  if (data.length < 4) return null;
  const b = data;

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  // GIF: "GIF87a" / "GIF89a"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  // BMP: "BM"
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  // WEBP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  // PDF: "%PDF"
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  // ZIP / docx / xlsx / pptx: "PK\x03\x04"
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  // Old MS Office (OLE2): D0 CF 11 E0
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  // MP4 / MOV / 3GP: bytes 4..7 == "ftyp"
  if (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) return 'mp4';
  // MP3 (ID3 tag only — raw-frame sync `FF Ex` is too loose, would false-match
  // garbage from a wrong AES key roughly 1 in 1024 times)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
  // SILK voice (WeChat voice format): "\x02#!SILK"
  if (b.length >= 7 && b[0] === 0x02 && b[1] === 0x23 && b[2] === 0x21 && b[3] === 0x53 && b[4] === 0x49 && b[5] === 0x4c && b[6] === 0x4b) return 'silk';

  return null;
}

function generateFileName(type: 'image' | 'file' | 'video'): string {
  // Date.now() alone collides for files that arrive in the same millisecond; add entropy.
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : 'bin';
  return `${type}_${stamp}.${ext}`;
}

/**
 * Sanitize an untrusted file name (a WeChat sender controls file_item.file_name and
 * the image URL path) so it can never escape the media directory or smuggle in path
 * separators / control chars. Falls back to a generated name when nothing safe remains.
 */
export function safeFileName(name: string | undefined, type: 'image' | 'file' | 'video'): string {
  if (!name) return generateFileName(type);
  // Normalize Windows separators first so basename() strips them even on POSIX,
  // then drop any directory components ("../../etc/passwd" -> "passwd").
  let base = basename(name.replace(/\\/g, '/'));
  // Remove control chars and characters illegal in file names across platforms.
  base = base.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  // Strip leading dots so "..", ".ssh", ".env" cannot be produced.
  base = base.replace(/^\.+/, '');
  if (!base) return generateFileName(type);
  // Cap absurdly long names (filesystem limits) while keeping the extension.
  if (base.length > 200) base = base.slice(base.length - 200);
  return base;
}

function extractFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/');
    return safeFileName(pathParts[pathParts.length - 1], 'image');
  } catch {
    return generateFileName('image');
  }
}

export function cleanupMedia(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      log.debug(`[media] Cleaned up: ${filePath}`);
    }
  } catch (err) {
    log.warn(`[media] Failed to cleanup ${filePath}:`, err);
  }
}

export function copyMediaToWorkDir(media: DownloadedMedia, workDir: string): DownloadedMedia {
  if (!workDir || media.path.startsWith(workDir)) {
    log.debug(`[media] No copy needed, workDir=${workDir}, media.path=${media.path}`);
    return media;
  }
  
  const mediaDir = ensureMediaDir(workDir);
  const newPath = join(mediaDir, media.fileName);
  
  log.debug(`[media] Copying from ${media.path} to ${newPath}`);
  
  if (!existsSync(media.path)) {
    log.error(`[media] Source file not found: ${media.path}`);
    return media;
  }
  
  try {
    copyFileSync(media.path, newPath);
    log.info(`[media] Copied to work dir: ${newPath}`);
    return {
      ...media,
      path: newPath,
    };
  } catch (err) {
    log.error(`[media] Failed to copy to work dir: ${err}`);
    return media;
  }
}

export function getGlobalMediaDir(): string {
  return GLOBAL_MEDIA_DIR;
}
