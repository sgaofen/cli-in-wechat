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

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['-p', prompt, '--output-format', 'json'];

      // Mode
      switch (settings.mode) {
        case 'auto': args.push('--dangerously-skip-permissions'); break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
        case 'safe': break;
      }

      // Effort
      if (settings.effort) args.push('--effort', settings.effort);

      // Max turns
      args.push('--max-turns', String(settings.maxTurns));

      // Model
      if (settings.model) args.push('--model', settings.model);

      // Budget
      if (settings.maxBudget > 0) args.push('--max-budget-usd', String(settings.maxBudget));

      // Allowed/disallowed tools
      if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
      if (settings.disallowedTools) args.push('--disallowedTools', settings.disallowedTools);

      // System prompt append
      if (settings.systemPrompt) args.push('--append-system-prompt', settings.systemPrompt);

      // Verbose
      if (settings.verbose) args.push('--verbose');

      // Bare
      if (settings.bare) args.push('--bare');

      // Add directory
      if (settings.addDir) args.push('--add-dir', settings.addDir);

      // Session name
      if (settings.sessionName) args.push('--name', settings.sessionName);

      // Session resume
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[claude] effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode}`);
      const proc = spawn(this.command, args, {
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
        try {
          const r = JSON.parse(stdout);
          resolve({ text: r.result || '(无输出)', sessionId: r.session_id, duration: r.duration_ms, error: r.is_error || r.subtype !== 'success' });
        } catch {
          resolve({ text: stdout.trim() || stderr.trim() || `exit ${code}`, error: code !== 0 });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动 Claude Code: ${err.message}`, error: true }); });
    });
  }
}

// ─── Shared helpers ────────────────────────────────────────
export function commandExists(cmd: string): Promise<boolean> {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => { const proc = spawn(checker, [cmd], { stdio: 'pipe' }); proc.on('close', (code) => resolve(code === 0)); proc.on('error', () => resolve(false)); });
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
