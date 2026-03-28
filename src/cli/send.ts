import { randomUUID } from 'node:crypto';
import { generateWechatUin } from '../utils/crypto.js';
import { loadCredentials, loadContextTokens } from '../config.js';
import type { Credentials } from '../ilink/types.js';

const CHANNEL_VERSION = '1.0.2';
const MAX_CHUNK_SIZE = 2000;

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
    const chunks = chunkText(message, MAX_CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      await sendRawMessage(credentials, userId, contextToken, chunks[i]);
      if (i < chunks.length - 1) {
        await sleep(300);
      }
    }
    console.log('已发送');
  } catch (err) {
    console.error(`发送失败: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function sendRawMessage(
  credentials: Credentials,
  userId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const res = await fetch(
    `${credentials.baseUrl}/ilink/bot/sendmessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${credentials.botToken}`,
        'X-WECHAT-UIN': generateWechatUin(),
      },
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1 as const, text_item: { text } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`);
  }

  const data = (await res.json()) as { ret?: number; errmsg?: string };
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(data.errmsg || `ret=${data.ret}`);
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
