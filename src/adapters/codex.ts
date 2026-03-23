import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
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
      const args: string[] = [];
      const sid = opts.settings.sessionIds[this.name];

      if (sid) {
        args.push('exec', 'resume', sid, prompt);
      } else {
        args.push(
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',  // always max permissions
          '--skip-git-repo-check',
          prompt,
        );
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] executing`);
      const proc = spawn(this.command, args, {
        cwd: opts.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        resolve({ text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`, error: code !== 0 });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }
}
