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

文件已保存到工作目录，等待您的指令。${userPrompt}`;
}

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
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} sandbox=${settings.sandbox || 'yolo'} search=${settings.search}`);
      const proc = spawnProc(this.command, args, {
        cwd: opts.workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Pass prompt via stdin to avoid Windows cmd.exe Unicode encoding issues
      log.debug(`[codex] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
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
