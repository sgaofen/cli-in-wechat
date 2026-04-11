import { writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { log } from './logger.js';
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
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MicroMessenger/6.0',
    },
  });
  
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error(`[media] HTTP ${response.status}: ${body.substring(0, 200)}`);
    throw new Error(`Failed to download media: HTTP ${response.status}`);
  }
  
  let data: Uint8Array = new Uint8Array(await response.arrayBuffer());
  
  // 微信 CDN 下载的文件都是加密的，需要解密
  // aes_key 存在时必须解密
  if (aes_key) {
    try {
      data = decryptMedia(Buffer.from(data), aes_key);
      log.debug(`[media] Decrypted ${data.length} bytes`);
    } catch (err) {
      log.warn(`[media] Decrypt failed, file may not be encrypted: ${err}`);
      // 解密失败可能是因为文件本身未加密，继续使用原始数据
    }
  }
  
  const fileName = options.fileName || generateFileName(options.type);
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
      const response = await fetch(item.url, {
        headers: { 'User-Agent': 'MicroMessenger/6.0' },
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
  const key = parseAesKey(aesKeyBase64);
  
  // 尝试 ECB 解密（微信 CDN 上传用的是 ECB）
  try {
    const decipherEcb = createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([decipherEcb.update(data), decipherEcb.final()]);
    // 检查解密结果是否像真实文件
    const header = decrypted.slice(0, 4).toString('ascii');
    if (header === '%PDF' || header === 'PK\x03\x04' || header.startsWith('\xd0\xcf') || header.startsWith('\x89PNG')) {
      log.debug(`[media] ECB decryption successful, header: ${header}`);
      return decrypted;
    }
  } catch {
    // ECB 解密失败，尝试 CBC
  }
  
  // 尝试 CBC 解密（IV 为全零）
  const decipherCbc = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([decipherCbc.update(data), decipherCbc.final()]);
}

function generateFileName(type: 'image' | 'file' | 'video'): string {
  const timestamp = Date.now();
  const ext = type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : 'bin';
  return `${type}_${timestamp}.${ext}`;
}

function extractFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/');
    return pathParts[pathParts.length - 1] || generateFileName('image');
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
