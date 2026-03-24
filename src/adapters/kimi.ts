import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi, spawnOpts } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class KimiAdapter implements CLIAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly command = 'kimi';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args: string[] = [];

      // ── Prompt ──
      args.push('-p', prompt);

      // ── Print mode (non-interactive, implies --yolo) ──
      args.push('--print');

      // ── Output format ──
      // Use text + final-message-only for clean output (like --quiet but we control it)
      args.push('--output-format', 'text', '--final-message-only');

      // ── Mode ──
      // --print already implies --yolo (auto-approve all)
      // For plan mode, we don't add --yolo equivalent since --print includes it
      // but we can hint via prompt or use plan-specific behavior

      // ── Model ──
      if (settings.model) args.push('-m', settings.model);

      // ── Thinking mode ──
      if (settings.thinking) {
        args.push('--thinking');
      }

      // ── Max steps ──
      if (settings.maxTurns) {
        args.push('--max-steps-per-turn', String(settings.maxTurns));
      }

      // ── Session resume ──
      const sid = settings.sessionIds[this.name];
      if (sid) {
        args.push('-S', sid);
      } else if (false /* kimiContinue not yet exposed */) {
        args.push('-C'); // continue last session
      }

      // ── Working directory ──
      if (settings.workDir || opts.workDir) {
        args.push('-w', settings.workDir || opts.workDir!);
      }

      // ── Additional directories ──
      if (settings.addDir) {
        args.push('--add-dir', settings.addDir);
      }

      // ── Verbose ──
      if (settings.verbose) args.push('--verbose');

      // ── System prompt (via config override) ──
      if (settings.systemPrompt) {
        args.push('--config', `agent.system_prompt_suffix="${settings.systemPrompt}"`);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[kimi] model=${settings.model || 'default'} thinking=${settings.thinking || false}`);

      const proc = spawn(this.command, args, spawnOpts(settings.workDir || opts.workDir) as any);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);

      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const output = stripAnsi(stdout.trim() || stderr.trim());

        // Try to extract session ID from stderr (kimi outputs session info there)
        const sidMatch = stderr.match(/session[_\s]id[:\s]+([a-f0-9-]+)/i);
        const sessionId = sidMatch?.[1] || (code === 0 ? 'continue' : undefined);

        resolve({
          text: output || `exit ${code}`,
          sessionId,
          error: code !== 0,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Kimi Code: ${err.message}`, error: true });
      });
    });
  }
}
