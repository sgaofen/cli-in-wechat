import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import {
  commandExists,
  spawnCli,
  setupAbort,
  setupTimeout,
  isSessionError,
  buildMediaPrompt,
  collectUtf8,
  writeStdin,
  summarizeToolUse,
  summarizeToolResult,
} from './base.js';

export class ClaudeAdapter implements CLIAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly command = 'claude';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings } = opts;
    const workDir = settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
    
    log.debug(`[claude] workDir: ${workDir}`);
    if (opts.media && opts.media.length > 0) {
      log.debug(`[claude] media paths: ${opts.media.map(m => m.path).join(', ')}`);
    }

    // Try Agent SDK for full interactive support (AskUserQuestion)
    try {
      return await this.executeWithSDK(fullPrompt, opts);
    } catch (sdkErr) {
      log.warn(`[claude] Agent SDK failed, falling back to CLI: ${(sdkErr as Error).message}`);
      return this.executeWithCLI(fullPrompt, opts);
    }
  }

  // ─── Agent SDK path (supports AskUserQuestion) ────────

  private async executeWithSDK(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { settings } = opts;
    const start = Date.now();
    const msgMode = settings.msgMode || 'compact';

    // Build options
    const sdkOpts: Record<string, unknown> = {
      maxTurns: settings.maxTurns,
      permissionMode: settings.mode === 'auto' ? 'bypassPermissions' : settings.mode === 'plan' ? 'plan' : 'default',
      // Load all settings sources to get complete skills/commands list
      settingSources: ['user', 'project', 'local'] as const,
    };

    if (settings.effort) sdkOpts.effort = settings.effort;
    if (settings.model) sdkOpts.model = settings.model;
    if (settings.maxBudget > 0) sdkOpts.maxBudgetUsd = settings.maxBudget;
    // `appendSystemPrompt` is NOT a public SDK Options field — it is silently dropped, so
    // /system was a no-op on the SDK path. Append via the preset systemPrompt form instead
    // (keeps Claude Code's default prompt and adds ours). The CLI fallback still uses
    // --append-system-prompt below.
    if (settings.systemPrompt) sdkOpts.systemPrompt = { type: 'preset', preset: 'claude_code', append: settings.systemPrompt };
    if (settings.allowedTools) sdkOpts.allowedTools = settings.allowedTools.split(',').map(s => s.trim());

    // Session resume
    const sid = settings.sessionIds[this.name];
    if (sid) sdkOpts.resume = sid;

    // Working directory
    if (settings.workDir || opts.workDir) sdkOpts.cwd = settings.workDir || opts.workDir;

    // AskUserQuestion handler
    if (opts.askUser) {
      const askUser = opts.askUser;
      sdkOpts.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === 'AskUserQuestion') {
          log.debug('[claude] AskUserQuestion input:', JSON.stringify(input, null, 2));
          try {
            const answers = await askUser({
              questions: (input.questions as Array<{
                question: string;
                options: Array<{ label: string; description?: string }>;
                multiSelect?: boolean;
              }>) || [],
            });
            log.debug('[claude] AskUserQuestion answers:', JSON.stringify(answers));
            return {
              behavior: 'allow' as const,
              updatedInput: { ...input, answers },
            };
          } catch (err) {
            log.error('[claude] AskUserQuestion failed:', err);
            return { behavior: 'deny' as const, message: '用户未回复' };
          }
        }
        return { behavior: 'allow' as const, updatedInput: input };
      };
    }

    // Timeout + cancellation for the SDK path.
    //
    // The `opts.signal?.aborted` check inside the loop below only runs when a message
    // arrives, so a query that produces nothing — e.g. a tool call blocked on an
    // interactive prompt such as `sudo` waiting for a password — hangs the loop forever.
    // The router keeps its per-user `active` lock for the whole call, so one stuck query
    // silently wedges the bridge for that user until the process restarts (observed: 8h37m).
    //
    // The CLI fallback already bounds itself via setupTimeout(); mirror that here by
    // driving the SDK's own AbortController from both the caller's signal and a timer.
    //
    // The timer measures IDLE time, not total duration: it is re-armed on every message,
    // so a long-but-healthy agent run is never cut off, while one that has stopped
    // producing output is aborted after `timeout` of silence. A total-duration cap would
    // be wrong here — unlike the other adapters, the SDK path is Claude's primary path
    // (the CLI is only a fallback), so capping it at cliTimeout (5 min by default) would
    // kill ordinary multi-step work. Idle is also what the message below promises.
    const sdkAbort = new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleTimeout = (): void => {
      if (!opts.timeout) return;
      if (abortTimer) clearTimeout(abortTimer);
      abortTimer = setTimeout(() => sdkAbort.abort(), opts.timeout);
    };
    const forwardAbort = () => sdkAbort.abort();
    opts.signal?.addEventListener('abort', forwardAbort, { once: true });
    sdkOpts.abortController = sdkAbort;
    // A signal that was already aborted before we subscribed never fires the listener.
    if (opts.signal?.aborted) sdkAbort.abort();
    armIdleTimeout();

    log.debug(`[claude/sdk] effort=${settings.effort} mode=${settings.mode} msgMode=${msgMode} resume=${sid || 'none'} timeout=${opts.timeout ?? 'none'}`);

    let resultText = '';
    let thinking = '';
    let sessionId: string | undefined;
    let error = false;

    // Stream intermediate messages via callback
    const { onIntermediate } = opts;
    const streamIntermediate = msgMode !== 'compact' && onIntermediate;

    // Track pending tool_use to associate with tool_result
    let pendingToolName: string | undefined;

    try {
      for await (const message of query({
        prompt,
        options: sdkOpts as Parameters<typeof query>[0]['options'],
      })) {
        if (opts.signal?.aborted) {
          return { text: '已取消', error: true };
        }
        armIdleTimeout();

        const msg = message as Record<string, unknown>;

        if (msg.type === 'assistant') {
          // SDK 用 message.content 存储 content blocks
          const msgObj = msg as any;
          const content = msgObj.content || msgObj.message?.content;
          if (content) {
            for (const block of content) {
              if (block.type === 'thinking' && block.thinking) {
                thinking += block.thinking;
                if (streamIntermediate) {
                  onIntermediate({ type: 'thinking', content: block.thinking });
                }
              }
              if (block.type === 'text' && block.text) {
                // Intermediate text output
                if (streamIntermediate && block.text.trim()) {
                  onIntermediate({ type: 'text', content: block.text });
                }
              }
              if (block.type === 'tool_use') {
                pendingToolName = block.name;
                if (streamIntermediate) {
                  onIntermediate({
                    type: 'tool_use',
                    content: summarizeToolUse(block.name || 'Tool', block.input),
                    toolName: block.name,
                  });
                }
              }
            }
          }
        }

        if (msg.type === 'user') {
          // SDK 用 message.content 存储 tool_result
          const msgObj = msg as any;
          const content = msgObj.content || msgObj.message?.content;
          if (content && streamIntermediate) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.content) {
                const summary = summarizeToolResult(pendingToolName, block.content);
                if (summary) {
                  onIntermediate({
                    type: 'tool_result',
                    content: summary,
                    toolName: pendingToolName,
                  });
                }
                pendingToolName = undefined;
              }
            }
          }
        }

        if (msg.type === 'result') {
          const result = msg as Record<string, unknown>;
          resultText = (result.result as string) || '(无输出)';
          sessionId = result.session_id as string;
          error = !!(result.is_error) || result.subtype !== 'success';
        }
      }
    } catch (err) {
      // Only our own abort lands here as a non-error outcome; anything else is a real
      // failure and must propagate so execute() can fall back to the CLI path.
      if (!sdkAbort.signal.aborted) throw err;
      if (opts.signal?.aborted) return { text: '已取消', error: true };
      // Timed out: return a result rather than throwing, so execute() does NOT retry via
      // the CLI path — that would make the user wait a second full timeout.
      const mins = Math.round((opts.timeout ?? 0) / 60000);
      log.warn(`[claude/sdk] 空闲超时 (${opts.timeout}ms 无消息)，已中止`);
      return {
        text: `执行超时（${mins} 分钟无响应），已自动中止。\n可能是某个命令在等待输入（如 sudo 密码）。`,
        duration: Date.now() - start,
        error: true,
      };
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      opts.signal?.removeEventListener('abort', forwardAbort);
    }

    return {
      text: resultText,
      thinking: thinking || undefined,
      sessionId,
      duration: Date.now() - start,
      error,
    };
  }

  // ─── CLI fallback (no AskUserQuestion) ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      // -p enables print (non-interactive) mode; prompt is passed via stdin below.
      // `--thinking`/`--max-turns` were removed from the Claude CLI (2.x); thinking is now
      // model/effort-driven and turn caps are configured elsewhere, so neither is passed here.
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];

      switch (settings.mode) {
        case 'auto': args.push('--dangerously-skip-permissions'); break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
      }
      if (settings.effort) args.push('--effort', settings.effort);
      if (settings.model) args.push('--model', settings.model);
      if (settings.maxBudget > 0) args.push('--max-budget-usd', String(settings.maxBudget));
      if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
      if (settings.disallowedTools) args.push('--disallowedTools', settings.disallowedTools);
      if (settings.systemPrompt) args.push('--append-system-prompt', settings.systemPrompt);
      if (settings.bare) args.push('--bare');
      if (settings.addDir) args.push('--add-dir', settings.addDir);
      if (settings.sessionName) args.push('--name', settings.sessionName);
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[claude] effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode}`);
      log.debug(`[claude] stdin prompt length: ${prompt.length}`);

      const proc = spawnCli(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // 通过 stdin 传递提示词
      writeStdin(proc, prompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const collected = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const stdout = collected.stdout(), stderr = collected.stderr();
        let text = '';
        let thinking = '';
        let sessionId: string | undefined;
        let duration: number | undefined;
        let isErr = code !== 0;

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'thinking' && block.thinking) {
                  thinking += block.thinking;
                }
                if (block.type === 'text' && block.text) {
                  text += block.text;
                }
              }
            }
            if (obj.type === 'result') {
              if (!text) text = obj.result || '(无输出)';
              sessionId = obj.session_id;
              duration = obj.duration_ms;
              isErr = obj.is_error || obj.subtype !== 'success';
            }
          } catch { continue; }
        }

        if (text) {
          resolve({
            text,
            thinking: thinking || undefined,
            sessionId,
            duration,
            error: isErr,
            sessionExpired: isErr && !!sid && isSessionError(text),
          });
        } else {
          const fallbackText = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text: fallbackText, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(fallbackText) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
