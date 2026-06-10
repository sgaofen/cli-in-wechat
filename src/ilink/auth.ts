import { log } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/http.js';
import type { Credentials, QRCodeResponse, QRCodeStatusResponse } from './types.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export async function getQRCode(): Promise<QRCodeResponse> {
  // This is the first network call on startup and the exact crash site of issue #18:
  // a transient `read ECONNRESET` here used to take down the whole process. Retry hard.
  const res = await fetchWithRetry(
    `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { label: 'QR', retries: 4, retryOnHttpError: true, timeoutMs: 20_000 },
  );
  if (!res.ok) throw new Error(`获取二维码失败: HTTP ${res.status}`);
  return res.json() as Promise<QRCodeResponse>;
}

export async function pollQRCodeStatus(
  qrcode: string,
): Promise<QRCodeStatusResponse> {
  // Polled every 2s in a loop, so keep retries light — the loop itself is the outer retry.
  const res = await fetchWithRetry(
    `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { headers: { 'iLink-App-ClientVersion': '1' }, label: 'QR-status', retries: 1, timeoutMs: 15_000 },
  );
  if (!res.ok) throw new Error(`轮询二维码状态失败: HTTP ${res.status}`);
  return res.json() as Promise<QRCodeStatusResponse>;
}

/**
 * Full QR login flow.
 * @param onQRCode callback receiving the QR content string for display
 * @returns Credentials on success
 */
export async function login(
  onQRCode: (qrContent: string) => void,
): Promise<Credentials> {
  const maxRefreshes = 3;

  for (let attempt = 0; attempt < maxRefreshes; attempt++) {
    const qr = await getQRCode();

    // qrcode_img_content is the string to encode as a QR code for scanning
    onQRCode(qr.qrcode_img_content || qr.qrcode);
    log.info('请用微信扫描二维码登录...');

    const deadline = Date.now() + 5 * 60 * 1000; // 5 min

    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const status = await pollQRCodeStatus(qr.qrcode);

        switch (status.status) {
          case 'scaned':
            log.info('已扫码，请在手机上确认...');
            break;
          case 'confirmed':
            log.info('登录成功!');
            return {
              botToken: status.bot_token!,
              baseUrl: status.baseurl || DEFAULT_BASE_URL,
              ilinkBotId: status.ilink_bot_id!,
              ilinkUserId: status.ilink_user_id!,
            };
          case 'expired':
            log.warn('二维码已过期');
            break;
          case 'wait':
            break;
        }

        if (status.status === 'expired') break;
      } catch (err) {
        log.error('轮询状态出错:', (err as Error).message);
      }
    }

    if (attempt < maxRefreshes - 1) {
      log.info(`重新获取二维码 (${attempt + 1}/${maxRefreshes})...`);
    }
  }

  throw new Error('登录超时，请重试');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
