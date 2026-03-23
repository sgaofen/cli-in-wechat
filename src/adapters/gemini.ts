import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class GeminiAdapter implements CLIAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly command = 'gemini';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: [], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--approval-mode', 'yolo',  // always max permissions
      ];

      const sid = opts.settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[gemini] executing`);
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
        try {
          const r = JSON.parse(stdout);
          resolve({
            text: r.response || r.result || stdout.trim(),
            sessionId: r.sessionId || r.session_id,
            duration: r.stats?.duration_ms,
            error: !!r.error,
          });
        } catch {
          resolve({ text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`, error: code !== 0 });
        }
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Gemini CLI: ${err.message}`, error: true });
      });
    });
  }
}
