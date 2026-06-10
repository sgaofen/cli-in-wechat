import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';

import { collectUtf8, writeStdin, buildMediaPrompt, killProc } from '../src/adapters/base.js';
import type { DownloadedMedia } from '../src/utils/media.js';

// ─── collectUtf8: multibyte UTF-8 must survive chunk boundaries ──────────────

test('collectUtf8: a Chinese character split across two data chunks is not corrupted', async () => {
  const proc: any = { stdout: new PassThrough(), stderr: new PassThrough() };
  const out = collectUtf8(proc);

  // "你好" = e4 bd a0 e5 a5 bd. Split mid-character (after the first 2 bytes of 你).
  const full = Buffer.from('你好世界', 'utf8');
  const mid = 2; // splits the first multibyte char
  proc.stdout.write(full.subarray(0, mid));
  proc.stdout.write(full.subarray(mid));
  proc.stdout.end();

  await new Promise((r) => proc.stdout.on('end', r));

  const text = out.stdout();
  assert.equal(text, '你好世界');
  assert.ok(!text.includes('�'), 'no replacement character');
});

test('collectUtf8: stderr is collected independently', async () => {
  const proc: any = { stdout: new PassThrough(), stderr: new PassThrough() };
  const out = collectUtf8(proc);
  proc.stderr.write(Buffer.from('错误', 'utf8'));
  proc.stderr.end();
  proc.stdout.end();
  await new Promise((r) => proc.stderr.on('end', r));
  assert.equal(out.stderr(), '错误');
  assert.equal(out.stdout(), '');
});

// ─── writeStdin: a benign EPIPE must not throw / crash ───────────────────────

test('writeStdin: swallows an EPIPE error on the stdin stream', () => {
  const stdin = new PassThrough();
  const proc: any = { stdin };
  // Should not throw even though we immediately make the stream emit an error.
  assert.doesNotThrow(() => {
    writeStdin(proc, 'hello');
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  });
});

test('writeStdin: writes the data and ends the stream', async () => {
  const stdin = new PassThrough();
  const proc: any = { stdin };
  const chunks: Buffer[] = [];
  stdin.on('data', (c) => chunks.push(Buffer.from(c)));
  const ended = new Promise((r) => stdin.on('end', r));
  writeStdin(proc, '你好 prompt');
  stdin.resume();
  await ended;
  assert.equal(Buffer.concat(chunks).toString('utf8'), '你好 prompt');
});

test('writeStdin: no stdin (null) is a safe no-op', () => {
  assert.doesNotThrow(() => writeStdin({ stdin: null } as any, 'x'));
});

// ─── buildMediaPrompt: centralized formatter ─────────────────────────────────

test('buildMediaPrompt: returns the prompt unchanged when there is no media', () => {
  assert.equal(buildMediaPrompt('hi', undefined), 'hi');
  assert.equal(buildMediaPrompt('hi', []), 'hi');
});

test('buildMediaPrompt: lists files and appends the user prompt', () => {
  const media: DownloadedMedia[] = [
    { type: 'image', path: '/tmp/x/photo.jpg', fileName: 'photo.jpg', size: 2048 },
  ];
  const out = buildMediaPrompt('看看这张图', media); // no workDir → no copy
  assert.match(out, /photo\.jpg/);
  assert.match(out, /类型: 图片/);
  assert.match(out, /用户说：看看这张图/);
});

// ─── killProc: guards ────────────────────────────────────────────────────────

test('killProc: a process that already exited is a no-op', () => {
  assert.doesNotThrow(() => killProc({ killed: false, exitCode: 0, pid: 1 } as any));
  assert.doesNotThrow(() => killProc({ killed: true, exitCode: null, pid: 1 } as any));
});

test('killProc: actually terminates a live child (POSIX)', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const exited = new Promise<number | null>((r) => child.on('exit', (code, signal) => r(signal ? -1 : code)));
  killProc(child);
  const result = await exited;
  assert.equal(result, -1, 'child was killed by signal');
});
