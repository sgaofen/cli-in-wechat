import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

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

      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;
        resultText = (result.result as string) || '(无输出)';
        sessionId = result.session_id as string;
        error = !!(result.is_error) || result.subtype !== 'success';
      }
    }

    return {
      text: resultText,
      sessionId,
      duration: Date.now() - start,
      error,
    };
  }

  // ─── CLI fallback (no AskUserQuestion) ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['-p', prompt, '--output-format', 'json'];

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
      if (settings.verbose) args.push('--verbose');
      if (settings.bare) args.push('--bare');
      if (settings.addDir) args.push('--add-dir', settings.addDir);
      if (settings.sessionName) args.push('--name', settings.sessionName);
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      const proc = spawn(this.command, args, spawnOpts(settings.workDir || opts.workDir) as any);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        try {
          const r = JSON.parse(stdout);
          resolve({ text: r.result || '(无输出)', sessionId: r.session_id, duration: r.duration_ms, error: r.is_error || r.subtype !== 'success' });
        } catch {
          resolve({ text: stdout.trim() || stderr.trim() || `exit ${code}`, error: code !== 0 });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}

// ─── Shared helpers ────────────────────────────────────────
const IS_WIN = process.platform === 'win32';

/** Windows needs shell:true to find .cmd/.ps1 wrapper scripts */
export function spawnOpts(cwd?: string): Record<string, unknown> {
  return { cwd, stdio: ['ignore', 'pipe', 'pipe'] as const, env: { ...process.env }, shell: IS_WIN };
}

export function commandExists(cmd: string): Promise<boolean> {
  const bin = IS_WIN ? 'where' : 'which';
  return new Promise((resolve) => {
    const proc = spawn(bin, [cmd], { stdio: 'pipe', shell: IS_WIN });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
export function setupAbort(proc: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return; if (signal.aborted) { proc.kill('SIGTERM'); return; }
  const onAbort = () => proc.kill('SIGTERM'); signal.addEventListener('abort', onAbort, { once: true }); proc.on('close', () => signal.removeEventListener('abort', onAbort));
}
export function setupTimeout(proc: ChildProcess, timeout?: number): ReturnType<typeof setTimeout> | null {
  if (!timeout) return null; return setTimeout(() => proc.kill('SIGTERM'), timeout);
}
export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}
