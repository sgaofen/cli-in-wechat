import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnCli, setupAbort, setupTimeout, stripAnsi, isSessionError, buildMediaPrompt, collectUtf8, writeStdin } from './base.js';

export class CodexAdapter implements CLIAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly command = 'codex';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: [], hasEffort: false, hasModel: true, hasSearch: true, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];
      const hasSession = settings.sessionIds[this.name];

      if (hasSession) {
        args.push('exec', 'resume', '--last');
      } else {
        args.push('exec');

        // Mode / sandbox
        if (settings.mode === 'auto' && !settings.sandbox) {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else if (settings.sandbox) {
          args.push('--sandbox', settings.sandbox);
        } else {
          // `--full-auto` was removed from `codex exec` (0.128); workspace-write is the
          // equivalent "auto within a sandbox" default. exec auto-approves inside the sandbox.
          args.push('--sandbox', 'workspace-write');
        }

        args.push('--skip-git-repo-check');

        // Model
        if (settings.model) args.push('-m', settings.model);

        // Web search: `--search` is no longer an `exec` flag (it's top-level only). Since v0.128
        // web search is on-by-default in cached mode; force LIVE search via config override.
        if (settings.search) args.push('-c', 'tools.web_search=live');

        // Ephemeral
        if (settings.ephemeral) args.push('--ephemeral');

        // Profile
        if (settings.profile) args.push('--profile', settings.profile);

        // Add directory
        if (settings.addDir) args.push('--add-dir', settings.addDir);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} sandbox=${settings.sandbox || 'yolo'} search=${settings.search}`);
      const proc = spawnCli(this.command, args, {
        cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Pass prompt via stdin to avoid Windows cmd.exe Unicode encoding issues
      log.debug(`[codex] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
      writeStdin(proc, fullPrompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const stdout = out.stdout(), stderr = out.stderr();
        const text = stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`;
        // Mark session exists so next call uses --last to resume
        resolve({ text, sessionId: code === 0 ? 'last' : undefined, error: code !== 0, sessionExpired: code !== 0 && !!hasSession && isSessionError(text) });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }
}
