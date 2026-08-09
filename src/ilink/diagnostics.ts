import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeliveryDiagnosticEvent {
  event: string;
  [key: string]: unknown;
}

export interface DeliveryDiagnosticsOptions {
  maxTextBytes?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

const SECRET_KEYS = new Set([
  'token',
  'contexttoken',
  'bottoken',
  'authorization',
  'aes_key',
  'aeskey',
  'encrypt_query_param',
  'full_url',
  'url',
  'signedurl',
]);
const USER_ID_KEYS = new Set(['userid', 'from_user_id', 'to_user_id']);
const TEXT_KEYS = new Set(['text', 'body', 'errmsg', 'errormessage', 'message']);

export class DeliveryDiagnostics {
  private readonly maxTextBytes: number;
  private readonly now: () => number;
  private readonly onError?: (error: unknown) => void;
  private disabled = false;

  constructor(private readonly filePath: string, options: DeliveryDiagnosticsOptions = {}) {
    this.maxTextBytes = Math.max(32, Math.floor(options.maxTextBytes ?? 500));
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch (error) {
      this.disable(error);
    }
  }

  record(event: DeliveryDiagnosticEvent): void {
    if (this.disabled) return;
    try {
      const sanitized = redactDiagnostic({ timestamp: this.now(), ...event }, this.maxTextBytes);
      appendFileSync(this.filePath, `${JSON.stringify(sanitized)}\n`, 'utf8');
    } catch (error) {
      this.disable(error);
    }
  }

  private disable(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    try { this.onError?.(error); } catch { /* diagnostics must remain best-effort */ }
  }
}

export function redactDiagnostic(value: unknown, maxTextBytes = 500, key = ''): unknown {
  const normalizedKey = key.toLowerCase();
  if (SECRET_KEYS.has(normalizedKey)) {
    return typeof value === 'string' && value.length > 0 ? '***' : value;
  }
  if (USER_ID_KEYS.has(normalizedKey) && typeof value === 'string') {
    return value.length > 8 ? `${value.slice(0, 8)}...` : value;
  }
  if (TEXT_KEYS.has(normalizedKey) && typeof value === 'string') {
    return truncateUtf8(value, maxTextBytes);
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item, maxTextBytes, key));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = redactDiagnostic(childValue, maxTextBytes, childKey);
    }
    return output;
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '...';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let output = '';
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + nextBytes > budget) break;
    output += codePoint;
    bytes += nextBytes;
  }
  return `${output}${suffix}`;
}
