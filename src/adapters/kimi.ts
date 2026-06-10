import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, buildMediaPrompt, collectUtf8, writeStdin } from './base.js';

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
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];

      // ── Print mode (non-interactive, implies --yolo) ──
      // The prompt is fed via stdin (below), NOT argv: passing free-form user text as a
      // `-p <prompt>` argv element is a shell-injection vector on Windows where spawnProc
      // runs under cmd.exe (shell:true), so a WeChat message with &, |, %VAR%, etc. would
      // be interpreted by the shell. stdin avoids cmd.exe parsing entirely.
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
      // No hand-rolled quotes: spawn passes this as a single argv token, so quoting the
      // value ourselves both breaks on values containing quotes and adds injection surface.
      if (settings.systemPrompt) {
        args.push('--config', `agent.system_prompt_suffix=${settings.systemPrompt}`);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[kimi] model=${settings.model || 'default'} thinking=${settings.thinking || false}`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Feed the prompt over stdin (see note above) instead of argv.
      log.debug(`[kimi] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
      writeStdin(proc, fullPrompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const stdout = out.stdout(), stderr = out.stderr();
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
