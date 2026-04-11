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
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      // Prompt is passed via stdin below. PR #11 comment thread noted that
      // buildMediaPrompt injects newlines / special chars that break positional
      // arg passing on Windows cmd.exe with shell:true. stdin side-steps that.
      const args = ['run', '--format', 'json'];
      if (settings.showThoughts) args.push('--thinking');

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

      log.debug(`[opencode] executing: run --format json${settings.showThoughts ? ' --thinking' : ''}`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdin!.write(fullPrompt, 'utf8');
      proc.stdin!.end();

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
