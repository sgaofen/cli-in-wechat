import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, isSessionError } from './base.js';

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
      const { settings } = opts;
      const args = ['-p', prompt, '--output-format', 'json'];

      // Approval mode (default to yolo)
      args.push('--approval-mode', settings.approvalMode || 'yolo');

      // Model
      if (settings.model) args.push('-m', settings.model);

      // Include directories
      if (settings.includeDirs) args.push('--include-directories', settings.includeDirs);

      // Extensions
      if (settings.extensions) args.push('-e', settings.extensions);

      // Sandbox
      if (settings.sandbox) args.push('--sandbox');

      // Session resume
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[gemini] approval=${settings.approvalMode || 'yolo'} model=${settings.model || 'default'}`);
      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
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
          const isErr = !!r.error;
          const text = r.response || r.result || stdout.trim();
          resolve({
            text, sessionId: r.sessionId || r.session_id, duration: r.stats?.duration_ms, error: isErr,
            sessionExpired: isErr && !!sid && isSessionError(String(r.error || text)),
          });
        } catch {
          const raw = stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`;
          // 针对常见 Gemini API 错误给出更明确的提示
          if (raw.includes('ModelNotFoundError') || raw.includes('Requested entity was not found')) {
            const model = settings.model || '默认模型';
            resolve({ text: `模型 "${model}" 不存在或无访问权限。\n请用 /model 切换，例如:\n/model gemini-2.5-pro\n/model gemini-2.0-flash`, error: true });
          } else if (raw.includes('API_KEY') || raw.includes('PERMISSION_DENIED') || raw.includes('UNAUTHENTICATED')) {
            resolve({ text: `Gemini API 认证失败，请检查 GEMINI_API_KEY 是否正确。`, error: true });
          } else if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('quota')) {
            resolve({ text: `Gemini API 配额已用尽，请稍后再试。`, error: true });
          } else {
            resolve({ text: raw, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(raw) });
          }
        }
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Gemini CLI: ${err.message}`, error: true });
      });
    });
  }
}
