import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, isSessionError } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.substring(0, maxLen)}...` : text;
}

function basenameFromPath(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathLike;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = ['text', 'output', 'result', 'content', 'message'];
    for (const key of preferred) {
      if (key in obj) {
        const text = asString(obj[key]);
        if (text) return text;
      }
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = asString(obj[key]).trim();
    if (value) return value;
  }
  return '';
}

function summarizeToolUse(toolName: string, input: unknown): string {
  const t = toolName || 'Tool';
  const obj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};

  if (/^bash$/i.test(t)) {
    const cmd = pickStringField(obj, ['command', 'cmd', 'script']);
    return cmd
      ? `- Shell Command: \`${truncate(cmd.replace(/\s+/g, ' ').trim(), 120)}\``
      : '- Shell Command';
  }

  if (/^read$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Read File: \`${basenameFromPath(path)}\``
      : '- Read File';
  }

  if (/^skill$/i.test(t)) {
    const skill = pickStringField(obj, ['skill', 'name', 'skillName']);
    return skill
      ? `- Skill: \`${basenameFromPath(skill)}\``
      : '- Skill';
  }

  if (/^glob$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'glob']);
    return pattern
      ? `- Glob: \`${truncate(pattern, 80)}\``
      : '- Glob';
  }

  if (/^grep$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'query', 'regex']);
    return pattern
      ? `- Grep: \`${truncate(pattern, 80)}\``
      : '- Grep';
  }

  if (/^ls$/i.test(t)) {
    const path = pickStringField(obj, ['path', 'directory']);
    return path
      ? `- LS: \`${truncate(path, 80)}\``
      : '- LS';
  }

  if (/^edit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Edit File: \`${basenameFromPath(path)}\``
      : '- Edit File';
  }

  if (/^write$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Write File: \`${basenameFromPath(path)}\``
      : '- Write File';
  }

  if (/^multiedit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- MultiEdit: \`${basenameFromPath(path)}\``
      : '- MultiEdit';
  }

  if (/^notebookread$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookRead: \`${basenameFromPath(path)}\``
      : '- NotebookRead';
  }

  if (/^notebookedit$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookEdit: \`${basenameFromPath(path)}\``
      : '- NotebookEdit';
  }

  if (/^webfetch$/i.test(t)) {
    const url = pickStringField(obj, ['url', 'uri']);
    return url
      ? `- WebFetch: \`${truncate(url, 120)}\``
      : '- WebFetch';
  }

  if (/^websearch$/i.test(t)) {
    const query = pickStringField(obj, ['query', 'q', 'searchQuery']);
    return query
      ? `- WebSearch: \`${truncate(query, 100)}\``
      : '- WebSearch';
  }

  if (/^(task|agent)$/i.test(t)) {
    const sub = pickStringField(obj, ['agent', 'agent_type', 'subagent_type', 'name']);
    const prompt = pickStringField(obj, ['description', 'prompt', 'task', 'instruction']);
    if (sub && prompt) return `- ${t}: \`${sub}\` — ${truncate(prompt, 80)}`;
    if (sub) return `- ${t}: \`${sub}\``;
    if (prompt) return `- ${t}: ${truncate(prompt, 80)}`;
    return `- ${t}`;
  }

  if (/^todowrite$/i.test(t)) {
    return '- TodoWrite';
  }

  return `- ${t}`;
}

function summarizeToolResult(toolName: string | undefined, content: unknown): string {
  const text = asString(content).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const tool = (toolName || '').toLowerCase();
  if (tool === 'bash') {
    const exit = text.match(/Exit code\s+(-?\d+)/i);
    if (exit) return `  ↳ Exit: ${exit[1]}`;
    if (/\bno output\b/i.test(text)) return '  ↳ Exit: no output';
    return '';
  }

  if (tool === 'skill') {
    const m = text.match(/Launching skill:\s*([^\s]+)/i);
    if (m) return `  ↳ Launch: \`${m[1]}\``;
    return '';
  }

  if (tool === 'webfetch') {
    const status = text.match(/\b(?:HTTP|Status)\s*[: ]\s*(\d{3})/i);
    if (status) return `  ↳ HTTP: ${status[1]}`;
    return '';
  }

  if (tool === 'websearch') {
    const n = text.match(/(\d+)\s+(?:result|results|条)/i);
    if (n) return `  ↳ Results: ${n[1]}`;
    return '';
  }

  if (tool === 'agent' || tool === 'task') {
    if (/completed with no output/i.test(text)) return '  ↳ Completed';
    if (/error/i.test(text)) return '  ↳ Error';
    return '';
  }

  if (tool === 'read') {
    return '';
  }

  // Default: do not dump raw result excerpts to avoid noisy/low-value spam.
  return '';
}

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

文件已保存到工作目录。请勿主动读取或处理这些文件，等待用户明确指示需要做什么。${userPrompt}`;
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
    const msgMode = settings.msgMode || 'compact';

    // Build options
    const sdkOpts: Record<string, unknown> = {
      maxTurns: settings.maxTurns,
      permissionMode: settings.mode === 'auto' ? 'bypassPermissions' : settings.mode === 'plan' ? 'plan' : 'default',
      // Load all settings sources to get complete skills/commands list
      settingSources: ['user', 'project', 'local'] as const,
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
          log.debug('[claude] AskUserQuestion input:', JSON.stringify(input, null, 2));
          try {
            const answers = await askUser({
              questions: (input.questions as Array<{
                question: string;
                options: Array<{ label: string; description?: string }>;
                multiSelect?: boolean;
              }>) || [],
            });
            log.debug('[claude] AskUserQuestion answers:', JSON.stringify(answers));
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

    log.debug(`[claude/sdk] effort=${settings.effort} mode=${settings.mode} msgMode=${msgMode} resume=${sid || 'none'}`);

    let resultText = '';
    let thinking = '';
    let sessionId: string | undefined;
    let error = false;

    // Stream intermediate messages via callback
    const { onIntermediate } = opts;
    const streamIntermediate = msgMode !== 'compact' && onIntermediate;

    // Track pending tool_use to associate with tool_result
    let pendingToolName: string | undefined;

    for await (const message of query({
      prompt,
      options: sdkOpts as Parameters<typeof query>[0]['options'],
    })) {
      if (opts.signal?.aborted) {
        return { text: '已取消', error: true };
      }

      const msg = message as Record<string, unknown>;

      if (msg.type === 'assistant') {
        // SDK 用 message.content 存储 content blocks
        const msgObj = msg as any;
        const content = msgObj.content || msgObj.message?.content;
        if (content) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              thinking += block.thinking;
              if (streamIntermediate) {
                onIntermediate({ type: 'thinking', content: block.thinking });
              }
            }
            if (block.type === 'text' && block.text) {
              // Intermediate text output
              if (streamIntermediate && block.text.trim()) {
                onIntermediate({ type: 'text', content: block.text });
              }
            }
            if (block.type === 'tool_use') {
              pendingToolName = block.name;
              if (streamIntermediate) {
                onIntermediate({
                  type: 'tool_use',
                  content: summarizeToolUse(block.name || 'Tool', block.input),
                  toolName: block.name,
                });
              }
            }
          }
        }
      }

      if (msg.type === 'user') {
        // SDK 用 message.content 存储 tool_result
        const msgObj = msg as any;
        const content = msgObj.content || msgObj.message?.content;
        if (content && streamIntermediate) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.content) {
              const summary = summarizeToolResult(pendingToolName, block.content);
              if (summary) {
                onIntermediate({
                  type: 'tool_result',
                  content: summary,
                  toolName: pendingToolName,
                });
              }
              pendingToolName = undefined;
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
      // -p enables print (non-interactive) mode; prompt is passed via stdin below
      // to avoid Windows cmd.exe issues with special characters in shell mode.
      const args = ['-p', '--output-format', 'stream-json', '--thinking', 'enabled', '--verbose'];

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
          resolve({
            text,
            thinking: thinking || undefined,
            sessionId,
            duration,
            error: isErr,
            sessionExpired: isErr && !!sid && isSessionError(text),
          });
        } else {
          const fallbackText = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text: fallbackText, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(fallbackText) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}
