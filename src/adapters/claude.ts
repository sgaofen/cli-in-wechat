import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, isSessionError } from './base.js';

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

    // Try Agent SDK for full interactive support (AskUserQuestion)
    try {
      return await this.executeWithSDK(prompt, opts);
    } catch (sdkErr) {
      log.warn(`[claude] Agent SDK failed, falling back to CLI: ${(sdkErr as Error).message}`);
      return this.executeWithCLI(prompt, opts);
    }
  }

  // ─── Agent SDK path (supports AskUserQuestion) ────────

  private async executeWithSDK(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { settings } = opts;
    const start = Date.now();

    // Build options
    const sdkOpts: Record<string, unknown> = {
      maxTurns: settings.maxTurns,
      permissionMode: settings.mode === 'auto' ? 'bypassPermissions' : settings.mode === 'plan' ? 'plan' : 'default',
    };

    if (settings.effort) sdkOpts.effort = settings.effort;
    if (settings.model) sdkOpts.model = settings.model;
    if (settings.maxBudget > 0) sdkOpts.maxBudgetUsd = settings.maxBudget;
    if (settings.systemPrompt) sdkOpts.appendSystemPrompt = settings.systemPrompt;
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
          log.debug('[claude] AskUserQuestion intercepted, forwarding to WeChat');
          try {
            const answers = await askUser({
              questions: (input.questions as Array<{
                question: string;
                options: Array<{ label: string; description?: string }>;
                multiSelect?: boolean;
              }>) || [],
            });
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

    log.debug(`[claude/sdk] effort=${settings.effort} mode=${settings.mode} resume=${sid || 'none'}`);

    let resultText = '';
    let thinking = '';
    let sessionId: string | undefined;
    let error = false;

    for await (const message of query({
      prompt,
      options: sdkOpts as Parameters<typeof query>[0]['options'],
    })) {
      if (opts.signal?.aborted) {
        return { text: '已取消', error: true };
      }

      const msg = message as Record<string, unknown>;

      if (msg.type === 'assistant') {
        const content = msg.content as Array<{ type: string; thinking?: string }> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              thinking += block.thinking;
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
      const args = ['-p', prompt, '--output-format', 'stream-json', '--thinking', 'enabled', '--verbose'];

      switch (settings.mode) {
        case 'auto': args.push('--dangerously-skip-permissions'); break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
      }
      if (settings.effort) args.push('--effort', settings.effort);
      args.push('--max-turns', String(settings.maxTurns));
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
      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

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
          resolve({ text, thinking: thinking || undefined, sessionId, duration, error: isErr, sessionExpired: isErr && !!sid && isSessionError(text) });
        } else {
          const fallbackText = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text: fallbackText, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(fallbackText) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
