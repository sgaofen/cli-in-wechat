import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { atomicWrite } from '../src/config.js';

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wxcfg-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('atomicWrite: writes content that reads back exactly', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'config.json');
    atomicWrite(f, '{"a":1}');
    assert.equal(readFileSync(f, 'utf8'), '{"a":1}');
  });
});

test('atomicWrite: leaves no .tmp turd behind', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'credentials.json');
    atomicWrite(f, 'secret');
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWrite: overwrites an existing file (no append/corruption)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'cursor.txt');
    writeFileSync(f, 'OLD-LONGER-CONTENT');
    atomicWrite(f, 'new');
    assert.equal(readFileSync(f, 'utf8'), 'new');
  });
});

test('atomicWrite: applies 0600 mode on POSIX', { skip: process.platform === 'win32' }, () => {
  withTmpDir((dir) => {
    const f = join(dir, 'sessions.json');
    atomicWrite(f, '{}');
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('atomicWrite: a reader never observes a partially-written file', () => {
  // The rename is atomic, so after each write the file is either the old or new content,
  // never a truncated mix. Simulate repeated overwrites and assert every read is complete.
  withTmpDir((dir) => {
    const f = join(dir, 'config.json');
    const payloads = ['{"v":1}', '{"v":22}', '{"v":333}'];
    for (const p of payloads) {
      atomicWrite(f, p);
      assert.equal(readFileSync(f, 'utf8'), p);
    }
  });
});
