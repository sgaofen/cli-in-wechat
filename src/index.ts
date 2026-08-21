#!/usr/bin/env node
import { login } from './ilink/auth.js';
import { ILinkClient } from './ilink/client.js';
import { AdapterRegistry } from './adapters/registry.js';
import { SessionManager } from './bridge/session.js';
import { Router } from './bridge/router.js';
import {
  loadConfig,
  loadCredentials,
  saveCredentials,
  ensureDataDir,
  resolveAllowedUsers,
  DATA_DIR,
} from './config.js';
import { log, setLogLevel, LogLevel } from './utils/logger.js';
import { initProxyFromEnv } from './utils/http.js';
import { acquireSingleInstance } from './utils/single-instance.js';
import { join } from 'node:path';

let releaseInstance: (() => Promise<void>) | null = null;

async function main() {
  const subcommand = process.argv[2];
  if (subcommand === 'send') {
    const { sendCommand } = await import('./cli/send.js');
    await sendCommand(process.argv.slice(3));
    process.exit(0);
  }

  console.log(
    `
╔═════════════════════════════════════════════╗
║            cli-in-wechat  v0.1.0            ║
║  Claude / Codex / Gemini / Kimi / OpenCode  ║
╚═════════════════════════════════════════════╝
`,
  );

  ensureDataDir();
  const instance = await acquireSingleInstance(join(DATA_DIR, 'bridge.lock'));
  releaseInstance = instance.release;
  const config = loadConfig();

  if (process.argv.includes('--debug') || process.argv.includes('-d')) {
    setLogLevel(LogLevel.DEBUG);
  }

  // Honor HTTPS_PROXY/HTTP_PROXY so users behind a proxy can reach WeChat (issue #18).
  await initProxyFromEnv();

  // ─── 1. Detect CLI tools ─────────────────────────────

  log.info('检测已安装的 CLI 工具...');
  const registry = new AdapterRegistry();
  await registry.detectAvailable();

  const available = registry.getAvailableNames();
  if (available.length === 0) {
    log.error('没有检测到任何可用的 AI CLI 工具');
    log.error('请安装以下工具之一: claude, codex, gemini, kimi, opencode');
    process.exit(1);
  }

  // Validate default tool
  if (!registry.isAvailable(config.defaultTool)) {
    config.defaultTool = available[0];
    log.info(`默认工具: ${config.defaultTool}`);
  }

  // ─── 2. WeChat login ─────────────────────────────────

  // QR display helper, defined once and reused for initial login AND session-expiry self-heal.
  let qrGenerate: ((text: string, opts: { small: boolean }) => void) | null = null;
  try {
    const mod = await import('qrcode-terminal');
    const qt = mod.default || mod;
    qrGenerate = qt.generate?.bind(qt) ?? null;
  } catch {
    // fallback to URL display
  }
  const showQR = (qrContent: string) => {
    if (qrGenerate) qrGenerate(qrContent, { small: true });
    else log.info(`请用微信扫描二维码: ${qrContent}`);
  };

  let credentials = loadCredentials();
  if (!credentials) {
    log.info('需要登录微信 ClawBot...');
    credentials = await login(showQR);
    saveCredentials(credentials);
  } else {
    log.info('使用已保存的登录凭据');
  }

  const defaultedToOwner = config.allowedUsers.length === 0 && !config.allowAllUsers;
  config.allowedUsers = resolveAllowedUsers(config, credentials.ilinkUserId);
  if (config.allowAllUsers) {
    log.warn('⚠️ allowedUsers 为空：任何能私聊机器人的微信好友都可运行 CLI（拥有完整权限）。');
    log.warn('   关闭 allowAllUsers，或在 ~/.wx-ai-bridge/config.json 设置 allowedUsers 白名单。');
  } else if (defaultedToOwner) {
    log.info('allowedUsers 未配置：已安全限制为当前扫码登录用户。');
  }

  // ─── 3. Start bridge ─────────────────────────────────

  const ilink = new ILinkClient(credentials, {
    maxTextBytes: config.maxResponseChunkSize,
  });
  instance.setRequestHandler(async (request) => {
    const value = request as { type?: unknown; userId?: unknown; text?: unknown };
    if (value?.type !== 'send-text' || typeof value.userId !== 'string' || typeof value.text !== 'string') {
      throw new Error('invalid local bridge request');
    }
    return ilink.sendText(value.userId, value.text);
  });
  const sessions = new SessionManager();
  const router = new Router(ilink, registry, sessions, config);

  // Self-heal on session expiry (errcode -14/-13): re-run QR login instead of crashing.
  ilink.setReloginHandler(async () => {
    const creds = await login(showQR);
    saveCredentials(creds);
    return creds;
  });

  router.start();
  ilink.start();

  log.info(`桥接服务已启动`);
  log.info(`默认工具: ${config.defaultTool} | 可用: ${available.join(', ')}`);
  log.info('在微信 ClawBot 中发送消息即可开始');
  log.info('Ctrl+C 退出');

  // ─── Graceful shutdown ────────────────────────────────

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在关闭...`);
    try { router.stop(); } catch { /* ignore */ }
    try { ilink.stop(); } catch { /* ignore */ }
    try { registry.shutdown(); } catch { /* ignore */ }
    void releaseInstance?.();
    releaseInstance = null;
    // Give in-flight aborts (child SIGTERM/taskkill) a brief moment, then exit.
    setTimeout(() => process.exit(0), 300);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An unhandled *rejection* is usually a stray promise and safe to log-and-continue.
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝:', reason);
  });
  // An uncaught *exception* leaves the runtime in an undefined state (Node docs), so treat
  // it as fatal: clean up and exit non-zero, letting a supervisor restart a fresh process.
  process.on('uncaughtException', (err) => {
    log.error('未捕获的异常 (即将退出):', err);
    if (!shuttingDown) {
      shuttingDown = true;
      try { router.stop(); } catch { /* ignore */ }
      try { ilink.stop(); } catch { /* ignore */ }
      try { registry.shutdown(); } catch { /* ignore */ }
      void releaseInstance?.();
      releaseInstance = null;
    }
    setTimeout(() => process.exit(1), 200);
  });
}

main().catch(async (err) => {
  await releaseInstance?.();
  releaseInstance = null;
  const { isRetryableNetworkError, describeNetworkError } = await import('./utils/http.js');
  if (isRetryableNetworkError(err) || /ECONNRESET|fetch failed|网络请求/.test(String(err?.message))) {
    log.error('启动失败 (网络问题):');
    log.error(describeNetworkError(err));
    log.error('微信接口: https://ilinkai.weixin.qq.com — 确认本机可访问该地址后重试。');
  } else {
    log.error('启动失败:', err);
  }
  process.exit(1);
});
