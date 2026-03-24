import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi, spawnOpts } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class AiderAdapter implements CLIAdapter {
  readonly name = 'aider';
  readonly displayName = 'Aider';
  readonly command = 'aider';
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    jsonOutput: false,
    sessionResume: false,
    modes: ['auto', 'safe'],
    hasEffort: false,
    hasModel: true,
    hasSearch: false,
    hasBudget: false,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['--no-pretty', '--no-stream', '--no-auto-commits'];

      switch (settings.mode) {
        case 'auto':
          args.push('--yes-always');
          break;
        case 'safe':
        case 'plan':
          args.push('--dry-run');
          break;
      }

      if (settings.model) args.push('--model', settings.model);

      args.push('-m', prompt);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[aider] mode=${settings.mode}`);

      const proc = spawn(this.command, args, {
        ...spawnOpts(opts.workDir),
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);

      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        resolve({ text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`, error: code !== 0 });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Aider: ${err.message}`, error: true });
      });
    });
  }
}
