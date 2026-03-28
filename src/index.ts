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
} from './config.js';
import { log, setLogLevel, LogLevel } from './utils/logger.js';

async function main() {
  const subcommand = process.argv[2];
  if (subcommand === 'send') {
    const { sendCommand } = await import('./cli/send.js');
    await sendCommand(process.argv.slice(3));
    process.exit(0);
  }

  console.log(
    `
╔══════════════════════════════════════╗
║       cli-in-wechat  v0.1.0        ║
║  Claude / Codex / Gemini / Kimi    ║
╚══════════════════════════════════════╝
`,
  );

  ensureDataDir();
  const config = loadConfig();

  if (process.argv.includes('--debug') || process.argv.includes('-d')) {
    setLogLevel(LogLevel.DEBUG);
  }

  // ─── 1. Detect CLI tools ─────────────────────────────

  log.info('检测已安装的 CLI 工具...');
  const registry = new AdapterRegistry();
  await registry.detectAvailable();

  const available = registry.getAvailableNames();
  if (available.length === 0) {
    log.error('没有检测到任何可用的 AI CLI 工具');
    log.error('请安装以下工具之一: claude, codex, gemini, aider');
    process.exit(1);
  }

  // Validate default tool
  if (!registry.isAvailable(config.defaultTool)) {
    config.defaultTool = available[0];
    log.info(`默认工具: ${config.defaultTool}`);
  }

  // ─── 2. WeChat login ─────────────────────────────────

  let credentials = loadCredentials();

  if (!credentials) {
    log.info('需要登录微信 ClawBot...');

    let qrGenerate: ((text: string, opts: { small: boolean }) => void) | null = null;
    try {
      const mod = await import('qrcode-terminal');
      const qt = mod.default || mod;
      qrGenerate = qt.generate?.bind(qt) ?? null;
    } catch {
      // fallback to URL display
    }

    credentials = await login((qrContent) => {
      if (qrGenerate) {
        qrGenerate(qrContent, { small: true });
      } else {
        log.info(`请用微信扫描二维码: ${qrContent}`);
      }
    });

    saveCredentials(credentials);
  } else {
    log.info('使用已保存的登录凭据');
  }

  // ─── 3. Start bridge ─────────────────────────────────

  const ilink = new ILinkClient(credentials);
  const sessions = new SessionManager();
  const router = new Router(ilink, registry, sessions, config);

  router.start();
  ilink.start();

  log.info(`桥接服务已启动`);
  log.info(`默认工具: ${config.defaultTool} | 可用: ${available.join(', ')}`);
  log.info('在微信 ClawBot 中发送消息即可开始');
  log.info('Ctrl+C 退出');

  // ─── Graceful shutdown ────────────────────────────────

  const shutdown = () => {
    log.info('正在关闭...');
    ilink.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('启动失败:', err);
  process.exit(1);
});
