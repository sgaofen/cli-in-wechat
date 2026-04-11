import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi } from './base.js';
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

文件已保存到工作目录，等待您的指令。${userPrompt}`;
}

export class KimiAdapter implements CLIAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly command = 'kimi';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];

      // ── Prompt ──
      args.push('-p', fullPrompt);

      // ── Print mode (non-interactive, implies --yolo) ──
      args.push('--print');

      // ── Output format ──
      // Use text + final-message-only for clean output (like --quiet but we control it)
      args.push('--output-format', 'text', '--final-message-only');

      // ── Mode ──
      // --print already implies --yolo (auto-approve all)
      // For plan mode, we don't add --yolo equivalent since --print includes it
      // but we can hint via prompt or use plan-specific behavior

      // ── Model ──
      if (settings.model) args.push('-m', settings.model);

      // ── Thinking mode ──
      if (settings.thinking) {
        args.push('--thinking');
      }

      // ── Max steps ──
      if (settings.maxTurns) {
        args.push('--max-steps-per-turn', String(settings.maxTurns));
      }

      // ── Session resume ──
      const sid = settings.sessionIds[this.name];
      if (sid) {
        args.push('-S', sid);
      }

      // ── Working directory ──
      if (settings.workDir || opts.workDir) {
        args.push('-w', settings.workDir || opts.workDir!);
      }

      // ── Additional directories ──
      if (settings.addDir) {
        args.push('--add-dir', settings.addDir);
      }

      // ── Verbose ──
      if (settings.verbose) args.push('--verbose');

      // ── System prompt (via config override) ──
      if (settings.systemPrompt) {
        args.push('--config', `agent.system_prompt_suffix="${settings.systemPrompt}"`);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[kimi] model=${settings.model || 'default'} thinking=${settings.thinking || false}`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
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

        const output = stripAnsi(stdout.trim() || stderr.trim());

        // Try to extract session ID from stderr (kimi outputs session info there)
        const sidMatch = stderr.match(/session[_\s]id[:\s]+([a-f0-9-]+)/i);
        const sessionId = sidMatch?.[1] || (code === 0 ? 'continue' : undefined);

        resolve({
          text: output || `exit ${code}`,
          sessionId,
          error: code !== 0,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Kimi Code: ${err.message}`, error: true });
      });
    });
  }
}
