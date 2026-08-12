import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage } from '../src/adapters/base.js';
import { OpenCodeAdapter, type OpenCodeSpawn } from '../src/adapters/opencode.js';

interface SpawnCapture {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
  stdin: string;
}

const ADAPTER_JSONL = [
  {
    type: 'reasoning',
    sessionID: 'ses_adapter',
    part: { type: 'reasoning', text: ' reason ' },
  },
  {
    type: 'tool_use',
    sessionID: 'ses_adapter',
    part: {
      type: 'tool',
      callID: 'call_adapter',
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'exit 2' },
        error: 'Exit code 2\nfixture failure must stay private',
      },
    },
  },
  {
    type: 'tool_use',
    sessionID: 'ses_adapter',
    part: {
      type: 'tool',
      callID: 'call_adapter_fallback',
      tool: 'custom-tool',
      state: {
        status: 'error',
        input: { target: 'fixture' },
        error: 'unrecognized fixture failure must stay private',
      },
    },
  },
  {
    type: 'text',
    sessionID: 'ses_adapter',
    part: { type: 'text', text: ' final answer ' },
  },
  {
    type: 'step_finish',
    sessionID: 'ses_adapter',
    part: { type: 'step-finish', reason: 'error' },
  },
].map((event) => JSON.stringify(event)).join('\r\n');

function createFakeSpawn(stdoutText: string, closeCode = 0): {
  spawn: OpenCodeSpawn;
  capture: SpawnCapture;
} {
  const capture: SpawnCapture = { stdin: '' };
  const spawn: OpenCodeSpawn = (command, args, options) => {
    capture.command = command;
    capture.args = [...args];
    capture.options = options;

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { capture.stdin += chunk; });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      exitCode: null,
      pid: 4242,
      kill: () => true,
    });

    queueMicrotask(() => {
      stdout.end(stdoutText);
      stderr.end();
      Object.assign(child, { exitCode: closeCode });
      child.emit('close', closeCode, null);
    });
    return child;
  };
  return { spawn, capture };
}

function settings(msgMode: 'normal' | 'compact') {
  return {
    ...DEFAULT_SETTINGS,
    mode: 'auto' as const,
    model: 'minimax/MiniMax-M3',
    effort: 'high',
    workDir: 'C:\\fixture-work',
    sessionIds: { opencode: 'ses_resume' },
    msgMode,
  };
}

test('OpenCode execute maps activity and preserves current argv stdin and final result', async () => {
  const fake = createFakeSpawn(ADAPTER_JSONL);
  const activity: IntermediateMessage[] = [];
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('  prompt unchanged  ', {
    settings: settings('normal'),
    extraArgs: ['--fixture-extra'],
    onIntermediate: (message) => activity.push(message),
  });

  assert.equal(fake.capture.command, 'opencode');
  assert.deepEqual(fake.capture.args, [
    'run', '--format', 'json', '--thinking',
    '--dir', 'C:\\fixture-work',
    '--auto',
    '-m', 'minimax/MiniMax-M3',
    '--variant', 'thinking',
    '-s', 'ses_resume',
    '--fixture-extra',
  ]);
  assert.equal(fake.capture.options?.cwd, 'C:\\fixture-work');
  assert.equal(fake.capture.stdin, '  prompt unchanged  ');
  assert.deepEqual(result, {
    text: ' final answer ',
    thinking: ' reason ',
    sessionId: 'ses_adapter',
    error: true,
  });
  assert.deepEqual(activity, [
    { type: 'thinking', content: ' reason ' },
    { type: 'tool_use', content: '- Shell Command: `exit 2`', toolName: 'bash' },
    { type: 'tool_result', content: '  ↳ Exit: 2', toolName: 'bash' },
    { type: 'tool_use', content: '- custom-tool', toolName: 'custom-tool' },
    { type: 'tool_result', content: '  ↳ Error', toolName: 'custom-tool' },
    { type: 'text', content: ' final answer ' },
  ]);
});

test('OpenCode execute gates callbacks in compact mode but preserves the final result', async () => {
  const fake = createFakeSpawn(ADAPTER_JSONL);
  const activity: IntermediateMessage[] = [];
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('compact prompt', {
    settings: settings('compact'),
    onIntermediate: (message) => activity.push(message),
  });

  assert.deepEqual(activity, []);
  assert.deepEqual(result, {
    text: ' final answer ',
    thinking: ' reason ',
    sessionId: 'ses_adapter',
    error: true,
  });
});

test('OpenCode execute folds a nonzero process exit into the parsed result', async () => {
  const successJsonl = JSON.stringify({
    type: 'text',
    sessionID: 'ses_process_error',
    part: { type: 'text', text: 'partial answer' },
  });
  const fake = createFakeSpawn(successJsonl, 7);
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('process error prompt', {
    settings: settings('compact'),
  });

  assert.deepEqual(result, {
    text: 'partial answer',
    thinking: undefined,
    sessionId: 'ses_process_error',
    error: true,
  });
});
