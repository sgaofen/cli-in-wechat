import {
  DATA_DIR,
  loadCredentials,
  loadContextTokens,
} from '../config.js';
import type { Credentials } from '../ilink/types.js';
import { ILinkClient } from '../ilink/client.js';
import type { SendResult } from '../ilink/send-result.js';
import {
  acquireSingleInstance,
  requestRunningInstance,
  SingleInstanceError,
} from '../utils/single-instance.js';
import { join } from 'node:path';

export async function sendCommand(args: string[]): Promise<void> {
  // ─── Parse arguments ─────────────────────────────────
  let targetUser: string | null = null;
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-u' || args[i] === '--user') {
      if (i + 1 >= args.length) {
        console.error('错误: -u 需要指定用户 ID');
        process.exit(1);
      }
      targetUser = args[++i];
    } else {
      messageParts.push(args[i]);
    }
  }

  // ─── Get message text ────────────────────────────────
  let message = messageParts.join(' ');

  if (!message) {
    if (process.stdin.isTTY === false) {
      message = await readStdin();
    }
  }

  if (!message) {
    printUsage();
    process.exit(1);
  }

  // ─── Load credentials ────────────────────────────────
  const credentials = loadCredentials();
  if (!credentials) {
    console.error('错误: 未登录。请先运行 `npm run dev` 扫码登录。');
    process.exit(1);
  }

  // ─── Determine target user ───────────────────────────
  const userId = targetUser || credentials.ilinkUserId;

  // ─── Load context_token ──────────────────────────────
  const contextTokens = loadContextTokens();
  const contextToken = contextTokens.get(userId);

  if (!contextToken) {
    if (targetUser) {
      console.error(`错误: 用户 ${userId} 未发送过消息给 bot，无法发送。`);
    } else {
      console.error('错误: 你还没有从微信给 bot 发过消息，请先发一条消息。');
    }
    process.exit(1);
  }

  // ─── Send message ────────────────────────────────────
  try {
    const results = await deliverCliText(credentials, userId, message);
    const sent = results.filter((result) => result.status === 'sent').length;
    const queued = results.length - sent;
    console.log(queued === 0 ? '已发送' : `已发送 ${sent} 条，另有 ${queued} 条进入持久队列`);
  } catch (err) {
    console.error(`发送失败: ${(err as Error).message}`);
    process.exit(1);
  }
}

export async function deliverCliText(
  credentials: Credentials,
  userId: string,
  text: string,
): Promise<SendResult[]> {
  return deliverCliTextAt(credentials, userId, text, join(DATA_DIR, 'bridge.lock'));
}

export async function deliverCliTextAt(
  credentials: Credentials,
  userId: string,
  text: string,
  lockPath: string,
): Promise<SendResult[]> {
  const running = await requestRunningInstance(lockPath, { type: 'send-text', userId, text });
  if (running) {
    if (!running.ok) throw new Error(running.error || 'running bridge rejected the send request');
    return running.value as SendResult[];
  }

  let owner;
  try {
    owner = await acquireSingleInstance(lockPath);
  } catch (error) {
    if (!(error instanceof SingleInstanceError)) throw error;
    const raced = await requestRunningInstance(lockPath, { type: 'send-text', userId, text });
    if (!raced) throw error;
    if (!raced.ok) throw new Error(raced.error || 'running bridge rejected the send request');
    return raced.value as SendResult[];
  }

  try {
    const client = new ILinkClient(credentials);
    return await client.sendText(userId, text);
  } finally {
    await owner.release();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

function printUsage(): void {
  console.log(`用法: wcli send [选项] <消息>

选项:
  -u, --user <userId>    指定目标用户 ID（默认发给自己）

示例:
  wcli send "hello"                    发送消息给自己
  wcli send "hello" -u wx_xxxxxx       发送给指定用户
  echo "hello" | wcli send             从标准输入读取消息`);
}
