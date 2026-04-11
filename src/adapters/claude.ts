import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, isSessionError } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';

function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;
  
  // 复制文件到工作目录
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

export class ClaudeAdapter implements CLIAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly command = 'claude';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings } = opts;
    const workDir = settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
    
    log.debug(`[claude] workDir: ${workDir}`);
    if (opts.media && opts.media.length > 0) {
      log.debug(`[claude] media paths: ${opts.media.map(m => m.path).join(', ')}`);
    }

    // Try Agent SDK for full interactive support (AskUserQuestion)
    try {
      return await this.executeWithSDK(fullPrompt, opts);
    } catch (sdkErr) {
      log.warn(`[claude] Agent SDK failed, falling back to CLI: ${(sdkErr as Error).message}`);
      return this.executeWithCLI(fullPrompt, opts);
    }
  }

  // ─── Agent SDK path (supports AskUserQuestion) ────────

  private async executeWithSDK(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { settings } = opts;
    const start = Date.now();

    // Build options
    const sdkOpts: Record<string, unknown> = {
      maxTurns: settings.maxTurns,
      permissionMode: settings.mode === 'auto' ? 'bypassPermissions' : settings.mode === 'plan' ? 'plan' : 'default',
    };

    if (settings.effort) sdkOpts.effort = settings.effort;
    if (settings.model) sdkOpts.model = settings.model;
    if (settings.maxBudget > 0) sdkOpts.maxBudgetUsd = settings.maxBudget;
    if (settings.systemPrompt) sdkOpts.appendSystemPrompt = settings.systemPrompt;
    if (settings.allowedTools) sdkOpts.allowedTools = settings.allowedTools.split(',').map(s => s.trim());

    // Session resume
    const sid = settings.sessionIds[this.name];
    if (sid) sdkOpts.resume = sid;

    // Working directory
    if (settings.workDir || opts.workDir) sdkOpts.cwd = settings.workDir || opts.workDir;

    // AskUserQuestion handler
    if (opts.askUser) {
      const askUser = opts.askUser;
      sdkOpts.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === 'AskUserQuestion') {
          log.debug('[claude] AskUserQuestion intercepted, forwarding to WeChat');
          try {
            const answers = await askUser({
              questions: (input.questions as Array<{
                question: string;
                options: Array<{ label: string; description?: string }>;
                multiSelect?: boolean;
              }>) || [],
            });
            return {
              behavior: 'allow' as const,
              updatedInput: { ...input, answers },
            };
          } catch (err) {
            log.error('[claude] AskUserQuestion failed:', err);
            return { behavior: 'deny' as const, message: '用户未回复' };
          }
        }
        return { behavior: 'allow' as const, updatedInput: input };
      };
    }

    log.debug(`[claude/sdk] effort=${settings.effort} mode=${settings.mode} resume=${sid || 'none'}`);

    let resultText = '';
    let thinking = '';
    let sessionId: string | undefined;
    let error = false;

    for await (const message of query({
      prompt,
      options: sdkOpts as Parameters<typeof query>[0]['options'],
    })) {
      if (opts.signal?.aborted) {
        return { text: '已取消', error: true };
      }

      const msg = message as Record<string, unknown>;

      if (msg.type === 'assistant') {
        // SDKAssistantMessage wraps the Anthropic message: content lives at msg.message.content,
        // not directly on msg (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
        const inner = msg.message as { content?: Array<{ type: string; thinking?: string }> } | undefined;
        const content = inner?.content;
        if (content) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              thinking += block.thinking;
            }
          }
        }
      }

      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;
        resultText = (result.result as string) || '(无输出)';
        sessionId = result.session_id as string;
        error = !!(result.is_error) || result.subtype !== 'success';
      }
    }

    return {
      text: resultText,
      thinking: thinking || undefined,
      sessionId,
      duration: Date.now() - start,
      error,
    };
  }

  // ─── CLI fallback (no AskUserQuestion) ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      // Prompt is passed via stdin below to avoid Windows cmd.exe issues with
      // special characters. --verbose is required for stream-json in -p mode.
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (settings.showThoughts) args.push('--thinking', 'enabled');

      switch (settings.mode) {
        case 'auto': args.push('--dangerously-skip-permissions'); break;
        case 'plan': args.push('--permission-mode', 'plan'); break;
      }
      if (settings.effort) args.push('--effort', settings.effort);
      args.push('--max-turns', String(settings.maxTurns));
      if (settings.model) args.push('--model', settings.model);
      if (settings.maxBudget > 0) args.push('--max-budget-usd', String(settings.maxBudget));
      if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
      if (settings.disallowedTools) args.push('--disallowedTools', settings.disallowedTools);
      if (settings.systemPrompt) args.push('--append-system-prompt', settings.systemPrompt);
      if (settings.bare) args.push('--bare');
      if (settings.addDir) args.push('--add-dir', settings.addDir);
      if (settings.sessionName) args.push('--name', settings.sessionName);
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[claude] effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode}`);
      log.debug(`[claude] stdin prompt length: ${prompt.length}`);
      
      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // 通过 stdin 传递提示词
      proc.stdin!.write(prompt, 'utf8');
      proc.stdin!.end();

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        let text = '';
        let thinking = '';
        let sessionId: string | undefined;
        let duration: number | undefined;
        let isErr = code !== 0;

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'thinking' && block.thinking) {
                  thinking += block.thinking;
                }
                if (block.type === 'text' && block.text) {
                  text += block.text;
                }
              }
            }
            if (obj.type === 'result') {
              if (!text) text = obj.result || '(无输出)';
              sessionId = obj.session_id;
              duration = obj.duration_ms;
              isErr = obj.is_error || obj.subtype !== 'success';
            }
          } catch { continue; }
        }

        if (text) {
          resolve({ text, thinking: thinking || undefined, sessionId, duration, error: isErr, sessionExpired: isErr && !!sid && isSessionError(text) });
        } else {
          const fallbackText = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text: fallbackText, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(fallbackText) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
