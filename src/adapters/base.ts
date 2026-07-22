import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../utils/logger.js';
import { copyMediaToWorkDir, type DownloadedMedia } from '../utils/media.js';

export type ToolMode = 'auto' | 'safe' | 'plan';
export type MsgMode = 'verbose' | 'normal' | 'compact';

export interface UserSettings {
  // ── Universal ──
  defaultTool: string;
  mode: ToolMode;
  model: string;
  sessionIds: Record<string, string>;
  systemPrompt: string;
  workDir: string;

  // ── Claude Code ──
  effort: string;
  maxTurns: number;
  maxBudget: number;
  allowedTools: string;
  disallowedTools: string;
  verbose: boolean;
  bare: boolean;
  addDir: string;
  sessionName: string;

  // ── Codex ──
  sandbox: string;
  search: boolean;
  ephemeral: boolean;
  profile: string;

  // ── Kimi Code ──
  thinking: boolean;

  // ── Gemini ──
  approvalMode: string;
  includeDirs: string;
  extensions: string;

  // ── Output ──
  showThoughts: boolean;
  msgMode: MsgMode;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultTool: '',
  mode: 'auto',
  model: '',
  sessionIds: {},
  systemPrompt: '',
  workDir: '',
  effort: 'high',
  maxTurns: 30,
  maxBudget: 0,
  allowedTools: '',
  disallowedTools: '',
  verbose: false,
  bare: false,
  addDir: '',
  sessionName: '',
  sandbox: '',
  search: false,
  ephemeral: false,
  profile: '',
  thinking: false,
  approvalMode: '',
  includeDirs: '',
  extensions: '',
  showThoughts: false,
  msgMode: 'normal',
};

export interface AskUserRequest {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface ExecOptions {
  settings: UserSettings;
  workDir?: string;
  timeout?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
  askUser?: (req: AskUserRequest) => Promise<Record<string, string>>;
  media?: DownloadedMedia[];
  /** Callback for streaming intermediate messages to WeChat */
  onIntermediate?: (msg: IntermediateMessage) => void;
}

export interface ExecResult {
  text: string;
  thinking?: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  error?: boolean;
  /** Set by the adapter when the error is positively identified as a session/resume failure. */
  sessionExpired?: boolean;
}

export interface IntermediateMessage {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
}

export interface AdapterCapabilities {
  streaming: boolean;
  jsonOutput: boolean;
  sessionResume: boolean;
  modes: ToolMode[];
  hasEffort: boolean;
  hasModel: boolean;
  hasSearch: boolean;
  hasBudget: boolean;
}

export interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities;
  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts: ExecOptions): Promise<ExecResult>;
}

// ─── Shared process helpers ────────────────────────────────
export const WIN = process.platform === 'win32';

/** On Windows, npm CLI wrappers (.cmd files) require shell:true to be executed by cmd.exe.
 *  This is the same mechanism npm scripts rely on and is the only reliable approach.
 *  Limitation: %VAR% patterns in user-supplied args may be expanded by cmd.exe. */
export function spawnProc(cmd: string, args: string[], opts: import('node:child_process').SpawnOptions): ChildProcess {
  log.debug(`[spawn] ${cmd} ${args.map(a => JSON.stringify(a)).join(' ')}`);
  if (!WIN) return spawn(cmd, args, opts);
  return spawn(cmd, args, { ...opts, shell: true });
}

/** Cache of resolved Windows direct-spawn targets, keyed by command. `null` = resolution
 *  failed, so spawnCli falls back to the legacy shell:true path. */
const winTargetCache = new Map<string, { file: string; prepend: string[] } | null>();

/** Resolve a Windows command (usually an npm-generated `.cmd` shim) to a target that can be
 *  spawned WITHOUT a shell, so argv reaches the child verbatim. npm `.cmd` shims forward args
 *  through `%*`, which cmd.exe re-parses — mangling any argument containing & | %VAR% " ^ ( ).
 *  Bypassing the shim (run node.exe on the package's real .js entry, or the native .exe
 *  directly) sidesteps cmd.exe entirely. Returns null when resolution fails so the caller can
 *  fall back to shell:true without regressing. */
function resolveWinDirectTarget(command: string): { file: string; prepend: string[] } | null {
  if (winTargetCache.has(command)) return winTargetCache.get(command)!;
  let resolved: { file: string; prepend: string[] } | null = null;
  try {
    const where = execSync(`where ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const paths = where.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // A native .exe on PATH can be spawned directly.
    const exe = paths.find((p) => /\.exe$/i.test(p));
    if (exe) {
      resolved = { file: exe, prepend: [] };
    } else {
      // Parse the .cmd shim to find the real .exe / .js it launches.
      const shim = paths.find((p) => /\.cmd$/i.test(p));
      if (shim) {
        const content = readFileSync(shim, 'utf8');
        const dir = dirname(shim);
        // Collapse only INTERIOR double-backslashes; a leading `\\` (UNC share) must survive.
        const expand = (p: string) =>
          p.replace(/%~dp0\\?/gi, dir + '\\').replace(/%dp0%\\?/gi, dir + '\\').replace(/(?<=.)\\{2,}/g, '\\');
        const target = [...content.matchAll(/"([^"]+)"/g)]
          .map((m) => expand(m[1]))
          .filter((p) => /\.(js|cjs|mjs|exe)$/i.test(p))
          .pop();
        // Only trust a parsed target that actually exists — a mis-parse must degrade to the
        // shell fallback (resolved stays null), never poison-cache a permanently-broken path.
        if (target && existsSync(target)) {
          resolved = /\.exe$/i.test(target)
            ? { file: target, prepend: [] }
            : { file: process.execPath, prepend: [target] }; // node <entry.js>
        }
      }
    }
  } catch { resolved = null; }
  winTargetCache.set(command, resolved);
  return resolved;
}

/** Spawn a CLI so that every argv element reaches the child verbatim on all platforms.
 *  POSIX: plain spawn (no shell). Windows: spawn past the `.cmd` shim (node.exe + entry, or the
 *  native .exe) so cmd.exe never re-parses the argv; only if that resolution fails do we fall
 *  back to the legacy shell:true path. Use this for any adapter that puts free-form user text
 *  on argv (e.g. Kimi's `-p <prompt>`); it also protects user-controlled flag VALUES
 *  (/system, /dir, /model) that would otherwise be mangled by cmd.exe. */
export function spawnCli(cmd: string, args: string[], opts: import('node:child_process').SpawnOptions): ChildProcess {
  if (!WIN) {
    log.debug(`[spawn] ${cmd} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
    return spawn(cmd, args, opts);
  }
  const target = resolveWinDirectTarget(cmd);
  if (target) {
    const full = [...target.prepend, ...args];
    log.debug(`[spawn] ${target.file} ${full.map((a) => JSON.stringify(a)).join(' ')}`);
    return spawn(target.file, full, { ...opts, shell: false, windowsVerbatimArguments: false });
  }
  log.warn(`[spawn] '${cmd}' not resolved past shell; argv with & | % " ^ may be mangled on Windows`);
  return spawnProc(cmd, args, opts);
}

export function commandExists(cmd: string): Promise<boolean> {
  const checker = WIN ? 'where' : 'which';
  return new Promise((resolve) => { const proc = spawn(checker, [cmd], { stdio: 'pipe' }); proc.on('close', (code) => resolve(code === 0)); proc.on('error', () => resolve(false)); });
}

/** Terminate a spawned process. On Windows, spawnProc uses shell:true (cmd.exe wrapper),
 *  so proc.kill() only reaps cmd.exe and orphans the real CLI child — use taskkill /T to
 *  kill the whole tree. On POSIX a SIGTERM to the child is sufficient. */
export function killProc(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  if (WIN && proc.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });
      return;
    } catch { /* fall through to proc.kill */ }
  }
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
}

export function setupAbort(proc: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return; if (signal.aborted) { killProc(proc); return; }
  const onAbort = () => killProc(proc); signal.addEventListener('abort', onAbort, { once: true }); proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

export function setupTimeout(proc: ChildProcess, timeout?: number): ReturnType<typeof setTimeout> | null {
  if (!timeout) return null; return setTimeout(() => killProc(proc), timeout);
}

/** Attach a UTF-8 string decoder to a child's stdout/stderr so multibyte characters
 *  (Chinese/emoji) are never split across data chunks and mangled into U+FFFD. */
export function collectUtf8(proc: ChildProcess): { stdout: () => string; stderr: () => string } {
  let out = '', err = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (c: string) => { out += c; });
  proc.stderr?.on('data', (c: string) => { err += c; });
  return { stdout: () => out, stderr: () => err };
}

/** Write a prompt to a child's stdin, swallowing the benign EPIPE that occurs if the
 *  child closes stdin before we finish writing (otherwise it crashes the whole bridge). */
export function writeStdin(proc: ChildProcess, data: string): void {
  if (!proc.stdin) return;
  proc.stdin.on('error', (e) => log.debug('[spawn] stdin write error (ignored):', (e as Error).message));
  proc.stdin.write(data, 'utf8');
  proc.stdin.end();
}

/** Shared media-prompt builder. Previously duplicated verbatim across all five adapters,
 *  which forced multi-file edits for a single wording change (commit 9c84af6). */
export function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;

  const copiedMedia = workDir ? media.map((m) => copyMediaToWorkDir(m, workDir)) : media;

  const fileList = copiedMedia.map((m) => {
    const relativePath = workDir && m.path.startsWith(workDir)
      ? m.path.slice(workDir.length).replace(/^[/\\]/, '')
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

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

/** Returns true only when text matches known session/resume failure patterns from CLI tools. */
export function isSessionError(text: string): boolean {
  return /session.*not.*(found|exist)|no.*(valid|previous).*session|invalid.*session|session.*(invalid|expired|not.*found)|cannot.*resume|resume.*(fail|not.*found)/i.test(text);
}
