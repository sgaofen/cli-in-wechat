import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi } from './base.js';

export class OpenCodeAdapter implements CLIAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly command = 'opencode';
  readonly capabilities: AdapterCapabilities = {
    streaming: false, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args = ['run', prompt, '--format', 'json', '--thinking'];

      if (settings.workDir || opts.workDir) {
        args.push('--dir', settings.workDir || opts.workDir!);
      }

      if (settings.mode === 'auto') {
        args.push('--dangerously-skip-permissions');
      }

      if (settings.model) {
        args.push('-m', settings.model);
      }

      const sid = settings.sessionIds[this.name];
      if (sid) {
        args.push('-s', sid);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[opencode] executing: run --format json --thinking`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
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

        try {
          let text = '';
          let thinking = '';
          let sessionId: string | undefined;
          let hasError = code !== 0;

          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'text' && obj.part?.text) {
                text += obj.part.text;
              }
              if (obj.type === 'reasoning' && obj.part?.text) {
                thinking += obj.part.text;
              }
              if (obj.sessionID && !sessionId) {
                sessionId = obj.sessionID;
              }
              if (obj.type === 'step_finish' && obj.part?.reason === 'error') {
                hasError = true;
              }
            } catch {
              // ignore parse errors for individual lines
            }
          }

          if (text) {
            resolve({ text, thinking: thinking || undefined, sessionId, error: hasError });
          } else {
            resolve({ text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`, error: code !== 0 });
          }
        } catch {
          resolve({ text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`, error: code !== 0 });
        }
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 OpenCode: ${err.message}`, error: true });
      });
    });
  }
}
