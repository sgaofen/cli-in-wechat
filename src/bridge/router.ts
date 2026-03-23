import { log } from '../utils/logger.js';
import { ILinkClient } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';

interface ActiveTask { abort: AbortController; tool: string }

const TOOL_ALIASES: Record<string, string> = {
  claude: 'claude', cc: 'claude',
  codex: 'codex', cx: 'codex',
  gemini: 'gemini', gm: 'gemini',
  aider: 'aider', ai: 'aider',
};

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private active = new Map<string, ActiveTask>();
  private lastResponse = new Map<string, { tool: string; text: string }>();

  constructor(ilink: ILinkClient, registry: AdapterRegistry, sessions: SessionManager, config: BridgeConfig) {
    this.ilink = ilink;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
  }

  start(): void {
    this.ilink.onMessage((msg, text) => {
      this.handle(msg, text).catch((e) => log.error('路由异常:', e));
    });
  }

  private async handle(msg: WeixinMessage, text: string): Promise<void> {
    const uid = msg.from_user_id;
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(uid)) return;

    const trimmed = text.trim();

    // Busy check
    if (this.active.has(uid)) {
      await this.ilink.sendText(uid, '处理中...');
      return;
    }

    // ── Parse: @tool1>tool2 chain, @tool single, >> relay, plain text ──

    // Pattern: @tool1>tool2 prompt  →  chain: tool1 processes, output feeds tool2
    const chainMatch = trimmed.match(/^@(\w+)>(\w+)\s+([\s\S]+)$/);
    if (chainMatch) {
      const t1 = TOOL_ALIASES[chainMatch[1].toLowerCase()];
      const t2 = TOOL_ALIASES[chainMatch[2].toLowerCase()];
      const prompt = chainMatch[3].trim();
      if (t1 && t2 && this.registry.isAvailable(t1) && this.registry.isAvailable(t2)) {
        await this.chain(uid, t1, t2, prompt);
        return;
      }
    }

    // Pattern: >> prompt  →  relay: prepend last response as context
    if (trimmed.startsWith('>>')) {
      const rest = trimmed.substring(2).trim();
      const prev = this.lastResponse.get(uid);
      if (!prev) {
        await this.ilink.sendText(uid, '没有上一条回复可接力');
        return;
      }

      // >> @tool prompt  →  relay to specific tool
      let tool: string | undefined;
      let prompt = rest;
      const atMatch = rest.match(/^@(\w+)\s+([\s\S]+)$/);
      if (atMatch) {
        const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
        if (resolved && this.registry.isAvailable(resolved)) {
          tool = resolved;
          prompt = atMatch[2].trim();
          this.sessions.update(uid, { defaultTool: resolved });
        }
      }

      const toolName = tool || this.sessions.get(uid).defaultTool || this.config.defaultTool;
      const fullPrompt = `以下是 ${prev.tool} 的输出:\n\n${prev.text}\n\n---\n\n${prompt}`;
      await this.exec(uid, toolName, fullPrompt);
      return;
    }

    // Pattern: @tool prompt  →  single tool
    let tool: string | undefined;
    let prompt = trimmed;
    const atMatch = trimmed.match(/^@(\w+)\s+([\s\S]+)$/);
    if (atMatch) {
      const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
      if (resolved && this.registry.isAvailable(resolved)) {
        tool = resolved;
        prompt = atMatch[2].trim();
        this.sessions.update(uid, { defaultTool: resolved });
      }
    }

    const toolName = tool || this.sessions.get(uid).defaultTool || this.config.defaultTool;
    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n可用: ${this.registry.getAvailableNames().join(', ')}`);
      return;
    }

    await this.exec(uid, toolName, prompt);
  }

  // ─── Chain: tool1 → tool2 ─────────────────────────────

  private async chain(uid: string, tool1: string, tool2: string, prompt: string): Promise<void> {
    const adapter1 = this.registry.get(tool1);
    const adapter2 = this.registry.get(tool2);
    if (!adapter1 || !adapter2) return;

    const abort = new AbortController();
    this.active.set(uid, { abort, tool: `${tool1}>${tool2}` });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      const settings = this.sessions.get(uid);

      // Step 1: run tool1
      log.debug(`[chain] step1: ${tool1}`);
      const r1 = await adapter1.execute(prompt, {
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout, signal: abort.signal,
      });

      if (abort.signal.aborted || r1.error) {
        if (!abort.signal.aborted) {
          await this.ilink.sendText(uid, formatResponse(r1.text, { tool: adapter1.displayName, error: true }));
        }
        return;
      }

      if (r1.sessionId && adapter1.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool1, r1.sessionId);
      }

      // Step 2: run tool2 with tool1's output as context
      log.debug(`[chain] step2: ${tool2}`);
      const chainPrompt = `以下是 ${adapter1.displayName} 对「${prompt}」的分析结果:\n\n${r1.text}\n\n---\n\n请基于以上内容继续工作。`;

      const r2 = await adapter2.execute(chainPrompt, {
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout, signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      if (r2.sessionId && adapter2.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool2, r2.sessionId);
      }

      this.sessions.update(uid, { defaultTool: tool2 });
      this.lastResponse.set(uid, { tool: adapter2.displayName, text: r2.text });

      const elapsed = Date.now() - start;
      await this.ilink.sendText(uid, formatResponse(r2.text, {
        tool: `${adapter1.displayName} → ${adapter2.displayName}`,
        duration: elapsed,
        error: r2.error,
      }));
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[chain] 失败:`, err);
        await this.ilink.sendText(uid, `链式调用失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(uid);
    }
  }

  // ─── Execute single tool ──────────────────────────────

  private async exec(uid: string, toolName: string, prompt: string): Promise<void> {
    const adapter = this.registry.get(toolName);
    if (!adapter) return;

    const abort = new AbortController();
    this.active.set(uid, { abort, tool: toolName });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      const settings = this.sessions.get(uid);

      const result = await adapter.execute(prompt, {
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout,
        extraArgs: this.config.tools[toolName]?.args,
        signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      if (result.sessionId && adapter.capabilities.sessionResume) {
        this.sessions.setSession(uid, toolName, result.sessionId);
      }

      // Store for >> relay
      this.lastResponse.set(uid, { tool: adapter.displayName, text: result.text });

      await this.ilink.sendText(uid, formatResponse(result.text, {
        tool: adapter.displayName,
        duration: result.duration || (Date.now() - start),
        error: result.error,
      }));
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[${toolName}] 失败:`, err);
        await this.ilink.sendText(uid, `失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(uid);
    }
  }
}
