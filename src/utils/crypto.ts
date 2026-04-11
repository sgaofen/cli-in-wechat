import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parse AES key from base64 — handles both raw 16-byte keys
 * and hex-encoded keys (32 ASCII hex chars → 16 bytes).
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hex = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }
  throw new Error('Invalid aes_key format');
}

export function generateAesKey(): Buffer {
  return randomBytes(16);
}

/**
 * Encode AES key for message (hex -> base64)
 */
export function encodeMessageAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString('hex')).toString('base64');
}

/**
 * Generate X-WECHAT-UIN header value:
 * base64(String(random_uint32))
 */
export function generateWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export function md5(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}
