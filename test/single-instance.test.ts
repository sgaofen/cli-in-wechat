import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  acquireSingleInstance,
  requestRunningInstance,
  SingleInstanceError,
} from '../src/utils/single-instance.js';

test('a live unrelated PID in a stale lock file does not block acquisition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-single-instance-stale-pid-'));
  const lockPath = join(dir, 'bridge.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: 1 }), 'utf8');

    const owner = await acquireSingleInstance(lockPath);
    await owner.release();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the operating-system endpoint rejects a second owner and serves local requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-single-instance-owner-'));
  const lockPath = join(dir, 'bridge.lock');
  const owner = await acquireSingleInstance(lockPath);
  owner.setRequestHandler(async (request) => ({ echoed: request }));
  try {
    await assert.rejects(acquireSingleInstance(lockPath), SingleInstanceError);
    assert.deepEqual(await requestRunningInstance(lockPath, { type: 'ping' }), {
      ok: true,
      value: { echoed: { type: 'ping' } },
    });
  } finally {
    await owner.release();
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(await requestRunningInstance(lockPath, { type: 'ping' }), null);
});
