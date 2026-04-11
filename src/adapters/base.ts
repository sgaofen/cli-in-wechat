import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';

export type ToolMode = 'auto' | 'safe' | 'plan';

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

export function commandExists(cmd: string): Promise<boolean> {
  const checker = WIN ? 'where' : 'which';
  return new Promise((resolve) => { const proc = spawn(checker, [cmd], { stdio: 'pipe' }); proc.on('close', (code) => resolve(code === 0)); proc.on('error', () => resolve(false)); });
}

export function setupAbort(proc: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return; if (signal.aborted) { proc.kill('SIGTERM'); return; }
  const onAbort = () => proc.kill('SIGTERM'); signal.addEventListener('abort', onAbort, { once: true }); proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

export function setupTimeout(proc: ChildProcess, timeout?: number): ReturnType<typeof setTimeout> | null {
  if (!timeout) return null; return setTimeout(() => proc.kill('SIGTERM'), timeout);
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

/** Returns true only when text matches known session/resume failure patterns from CLI tools. */
export function isSessionError(text: string): boolean {
  return /session.*not.*(found|exist)|no.*(valid|previous).*session|invalid.*session|session.*(invalid|expired|not.*found)|cannot.*resume|resume.*(fail|not.*found)/i.test(text);
}
