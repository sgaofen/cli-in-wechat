import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi, spawnOpts } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

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
      const args: string[] = [];
      const hasSession = settings.sessionIds[this.name];

      if (hasSession) {
        args.push('exec', 'resume', '--last', prompt);
      } else {
        args.push('exec');

        // Mode / sandbox
        if (settings.mode === 'auto' && !settings.sandbox) {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else if (settings.sandbox) {
          args.push('--sandbox', settings.sandbox);
        } else {
          args.push('--full-auto');
        }

        args.push('--skip-git-repo-check');

        // Model
        if (settings.model) args.push('-m', settings.model);

        // Web search
        if (settings.search) args.push('--search');

        // Ephemeral
        if (settings.ephemeral) args.push('--ephemeral');

        // Profile
        if (settings.profile) args.push('--profile', settings.profile);

        // Add directory
        if (settings.addDir) args.push('--add-dir', settings.addDir);

        args.push(prompt);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} sandbox=${settings.sandbox || 'yolo'} search=${settings.search}`);
      const proc = spawn(this.command, args, {
        ...spawnOpts(opts.workDir),
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const text = stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`;
        // Mark session exists so next call uses --last to resume
        resolve({ text, sessionId: code === 0 ? 'last' : undefined, error: code !== 0 });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }
}
