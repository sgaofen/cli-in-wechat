import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnCli, setupAbort, setupTimeout, stripAnsi, isSessionError, buildMediaPrompt, collectUtf8 } from './base.js';

/**
 * Kimi Code CLI adapter (MoonshotAI/kimi-code, `@moonshot-ai/kimi-code`).
 *
 * Rewritten for the current flag surface (issue #21). The pre-1.x flags the old adapter used
 * — `--print`, `--final-message-only`, `--thinking`, `--max-steps-per-turn`, `-w`, `--verbose`,
 * `--config` — no longer exist. The current contract:
 *   • non-interactive: `-p <prompt>` with the prompt on ARGV (kimi does NOT read stdin here);
 *   • `-p` implies auto-approve and CANNOT be combined with --yolo/--auto/--plan, so the
 *     bridge's /mode is a no-op for Kimi (always auto in print mode);
 *   • resume: `--continue` (continue the most recent session in the cwd) — used instead of the
 *     `-S <id>` form because the session-id format has drifted across versions (session_<uuid>
 *     vs ULID); this mirrors the Codex `--last` approach and is version-stable;
 *   • `--output-format text`, `-m <model>`, `--add-dir <dir>` remain.
 *
 * The argv prompt is why this adapter uses spawnCli (not spawnProc): on Windows spawnProc runs
 * under cmd.exe (shell:true), which would mangle any prompt containing & | %VAR% " ^ ( ).
 */
export class KimiAdapter implements CLIAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly command = 'kimi';
  readonly capabilities: AdapterCapabilities = {
    streaming: false, jsonOutput: false, sessionResume: true,
    // Only auto is reachable in print mode (`-p` forbids --yolo/--auto/--plan).
    modes: ['auto'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];

      // ── Session resume ──
      // Auto-tracked runs store the 'continue' sentinel → resume the most recent session in the
      // cwd (version-stable, no fragile id parsing). If the user pinned a specific id via
      // /session set or /resume <id>, that real id is stored instead → target it with -S.
      // Both compose with --prompt (only --continue×--session and --prompt×--yolo/--auto/--plan
      // are mutually exclusive).
      const hasSession = settings.sessionIds[this.name];
      if (hasSession === 'continue') args.push('--continue');
      else if (hasSession) args.push('-S', hasSession);

      // ── Model ──
      if (settings.model) args.push('-m', settings.model);

      // ── Extra workspace directory ──
      if (settings.addDir) args.push('--add-dir', settings.addDir);

      // ── Non-interactive output format ──
      args.push('--output-format', 'text');

      // ── Prompt (non-interactive) ──
      // The prompt MUST be an argv value; spawnCli guarantees it reaches kimi verbatim on
      // every platform (no cmd.exe re-parsing on Windows).
      args.push('-p', fullPrompt);

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[kimi] model=${settings.model || 'default'} resume=${hasSession || 'new'}`);
      log.debug(`[kimi] prompt: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);

      const proc = spawnCli(this.command, args, {
        cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const stdout = out.stdout(), stderr = out.stderr();
        // Strip ANSI only. (A previous global "• " bullet-strip was removed: it corrupted
        // legitimate bulleted lists in Kimi's answer, since content and activity bullets are
        // indistinguishable by prefix alone.)
        const output = stripAnsi(stdout.trim() || stderr.trim()).trim();

        resolve({
          text: output || `exit ${code}`,
          // Sentinel: presence (not value) tells the router to pass --continue next time.
          sessionId: code === 0 ? 'continue' : undefined,
          error: code !== 0,
          sessionExpired: code !== 0 && !!hasSession && isSessionError(stripAnsi(stderr) || output),
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Kimi Code: ${err.message}`, error: true });
      });
    });
  }
}
