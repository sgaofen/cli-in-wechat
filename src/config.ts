import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Credentials } from './ilink/types.js';

/**
 * Write a file atomically: write to a sibling temp file (same directory, so rename is a
 * cheap inode swap on the same filesystem) then rename over the target. A crash mid-write
 * can never leave a half-written config/credentials/sessions file that fails to parse.
 * The mode is set on the temp file because rename replaces the inode (perms are not inherited).
 */
export function atomicWrite(filePath: string, data: string, mode = 0o600): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  // rename is atomic on the same filesystem; fall back to a direct write only if it fails
  // (e.g. an exotic FS that disallows rename-over), accepting the small non-atomic window.
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, data, { mode });
    try { unlinkSync(tmp); } catch { /* best-effort: don't leave a stale .tmp orphan */ }
  }
}

const DATA_DIR = join(homedir(), '.wx-ai-bridge');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const CREDENTIALS_FILE = join(DATA_DIR, 'credentials.json');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const POLL_CURSOR_FILE = join(DATA_DIR, 'poll_cursor.txt');
const CONTEXT_TOKENS_FILE = join(DATA_DIR, 'context_tokens.json');

export interface ToolConfig {
  args?: string[];
  files?: string[];
}

export interface BridgeConfig {
  defaultTool: string;
  maxResponseChunkSize: number;
  cliTimeout: number;
  typingInterval: number;
  allowedUsers: string[];
  allowAllUsers: boolean;
  workDir: string;
  tools: Record<string, ToolConfig>;
}

export const DEFAULT_MAX_RESPONSE_CHUNK_BYTES = 3_800;

const DEFAULT_CONFIG: BridgeConfig = {
  defaultTool: 'claude',
  maxResponseChunkSize: DEFAULT_MAX_RESPONSE_CHUNK_BYTES,
  cliTimeout: 300_000,      // 5 minutes
  typingInterval: 5_000,    // 5 seconds
  allowedUsers: [],
  allowAllUsers: false,
  workDir: process.cwd(),
  tools: {},
};

export function resolveAllowedUsers(config: BridgeConfig, authenticatedUserId: string): string[] {
  if (config.allowedUsers.length > 0 || config.allowAllUsers) return [...config.allowedUsers];
  return authenticatedUserId ? [authenticatedUserId] : [];
}

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is ignored when the dir already exists (and on Windows); repair it so
  // an already-present ~/.wx-ai-bridge (holding credentials) is not world-readable.
  try {
    chmodSync(DATA_DIR, 0o700);
    chmodSync(SESSIONS_DIR, 0o700);
  } catch { /* chmod is a no-op / unsupported on Windows; ignore */ }
}

export function loadConfig(): BridgeConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: BridgeConfig): void {
  ensureDataDir();
  atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
    if (!data.botToken) return null;
    return data as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  ensureDataDir();
  atomicWrite(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    atomicWrite(CREDENTIALS_FILE, '{}');
  }
}

export function loadPollCursor(): string {
  if (!existsSync(POLL_CURSOR_FILE)) return '';
  try {
    return readFileSync(POLL_CURSOR_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function savePollCursor(cursor: string): void {
  ensureDataDir();
  atomicWrite(POLL_CURSOR_FILE, cursor);
}

export function saveContextTokens(tokens: Map<string, string>): void {
  ensureDataDir();
  const obj: Record<string, string> = {};
  for (const [k, v] of tokens) obj[k] = v;
  atomicWrite(CONTEXT_TOKENS_FILE, JSON.stringify(obj, null, 2));
}

export function loadContextTokens(): Map<string, string> {
  if (!existsSync(CONTEXT_TOKENS_FILE)) return new Map();
  try {
    const raw = readFileSync(CONTEXT_TOKENS_FILE, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

export { DATA_DIR };
