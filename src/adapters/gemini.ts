import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, isSessionError } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';

function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;
  
  const copiedMedia = workDir ? media.map(m => copyMediaToWorkDir(m, workDir)) : media;
  
  const fileList = copiedMedia.map(m => {
    const relativePath = workDir && m.path.startsWith(workDir) 
      ? m.path.slice(workDir.length).replace(/^[\/\\]/, '')
      : m.path;
    const typeNames: Record<string, string> = { image: '图片', file: '文件', video: '视频' };
    const sizeStr = m.size ? `${(m.size / 1024).toFixed(1)}KB` : '未知大小';
    return `- ${m.fileName}\n  类型: ${typeNames[m.type] || '文件'}\n  大小: ${sizeStr}\n  路径: ${relativePath}`;
  }).join('\n\n');
  
  const userPrompt = prompt.trim() && !prompt.startsWith('[文件:') && !prompt.startsWith('[图片:') && !prompt.startsWith('[视频:')
    ? `\n\n用户说：${prompt}`
    : '';
  
  return `已接收到用户通过微信发送的文件：

${fileList}

文件已保存到工作目录。请勿主动读取或处理这些文件，等待用户明确指示需要做什么。${userPrompt}`;
}

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
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      // Pass prompt via stdin to avoid Windows cmd.exe special-character issues
      // (e.g. "|" in quoted messages being interpreted as a pipe by cmd.exe with shell:true).
      // Non-TTY stdin + --output-format json triggers headless mode without needing -p.
      const args = ['--output-format', 'json'];

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
        cwd: settings.workDir || opts.workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Write prompt to stdin
      log.debug(`[gemini] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
      proc.stdin!.write(fullPrompt, 'utf8');
      proc.stdin!.end();

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
