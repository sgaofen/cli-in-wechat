import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Credentials } from './ilink/types.js';

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
  workDir: string;
  tools: Record<string, ToolConfig>;
}

const DEFAULT_CONFIG: BridgeConfig = {
  defaultTool: 'claude',
  maxResponseChunkSize: 2000,
  cliTimeout: 300_000,      // 5 minutes
  typingInterval: 5_000,    // 5 seconds
  allowedUsers: [],          // empty = allow all
  workDir: process.cwd(),
  tools: {},
};

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
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
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
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
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    writeFileSync(CREDENTIALS_FILE, '{}', { mode: 0o600 });
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
  writeFileSync(POLL_CURSOR_FILE, cursor, { mode: 0o600 });
}

export function saveContextTokens(tokens: Map<string, string>): void {
  ensureDataDir();
  const obj: Record<string, string> = {};
  for (const [k, v] of tokens) obj[k] = v;
  const tmp = CONTEXT_TOKENS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, CONTEXT_TOKENS_FILE);
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
