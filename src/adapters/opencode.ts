import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, buildMediaPrompt, collectUtf8, writeStdin } from './base.js';
import { execSync } from 'node:child_process';

const modelResolveCache = new Map<string, string>();

export function resolveBareModelFromList(model: string, availableModels: string[]): string {
  const raw = model.trim().replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return raw;

  const suffix = `/${raw.toLowerCase()}`;
  const matches = availableModels
    .map((item) => item.trim())
    .filter((item) => item.includes('/'))
    .filter((item) => item.toLowerCase().endsWith(suffix));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return raw;

  const preferred = matches.find((item) => /baiduqianfancodingplan/i.test(item));
  return preferred || raw;
}

export class OpenCodeAdapter implements CLIAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly command = 'opencode';
  readonly capabilities: AdapterCapabilities = {
    streaming: false, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

private resolveModelArg(model: string, workDir?: string): string {
    const raw = model.trim().replace(/\/+$/, '');
    if (!raw || raw.includes('/')) return raw;

    const key = raw.toLowerCase();
    const cached = modelResolveCache.get(key);
    if (cached) return cached;

    try {
      const output = execSync('opencode models', {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const availableModels = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const resolved = resolveBareModelFromList(raw, availableModels);
      if (resolved !== raw) {
        modelResolveCache.set(key, resolved);
        log.debug(`[opencode] model alias resolved: ${raw} -> ${resolved}`);
        return resolved;
      }
      log.warn(`[opencode] model not found in available models: ${raw}, tried: ${availableModels.slice(0, 10).join(', ')}`);
      return raw;
    } catch (err) {
      log.warn(`[opencode] models command failed: ${(err as Error).message}`);
      return raw;
    }
  }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args = ['run', '--format', 'json', '--thinking'];

      if (settings.workDir || opts.workDir) {
        args.push('--dir', settings.workDir || opts.workDir!);
      }

      if (settings.mode === 'auto') {
        args.push('--dangerously-skip-permissions');
      }

      if (settings.model) {
        const resolvedModel = this.resolveModelArg(settings.model, settings.workDir || opts.workDir);
        args.push('-m', resolvedModel);
      }

      const sid = settings.sessionIds[this.name];
      if (sid) {
        args.push('-s', sid);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[opencode] executing: run --format json --thinking`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // 通过 stdin 传递提示词
      writeStdin(proc, fullPrompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const stdout = out.stdout(), stderr = out.stderr();

        log.debug(`[opencode] stdout length: ${stdout.length}, first 500 chars: ${stdout.substring(0, 500)}`);

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
                log.debug(`[opencode] found reasoning, length: ${obj.part.text.length}`);
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

          log.debug(`[opencode] final thinking length: ${thinking.length}`);
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
