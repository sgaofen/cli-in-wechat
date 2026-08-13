import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeliveryDiagnostics, redactDiagnostic } from '../src/ilink/diagnostics.js';

test('diagnostics persist event names and redact tokens, URLs, and large bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-diagnostics-'));
  const filePath = join(dir, 'delivery.jsonl');
  const diagnostics = new DeliveryDiagnostics(filePath, { maxTextBytes: 80 });

  diagnostics.record({
    event: 'request',
    userId: 'user-secret-123456',
    contextToken: 'context-token-secret',
    url: 'https://example.test/send?signature=secret',
    text: 'x'.repeat(200),
  });

  const line = readFileSync(filePath, 'utf8').trim();
  const parsed = JSON.parse(line) as any;
  assert.equal(parsed.event, 'request');
  assert.equal(parsed.contextToken, '***');
  assert.equal(parsed.url, '***');
  assert.equal(parsed.userId, 'user-sec...');
  assert.ok(parsed.text.endsWith('...'));
  assert.ok(!line.includes('context-token-secret'));
  assert.ok(!line.includes('signature=secret'));
});

test('redactDiagnostic preserves structured delivery counters', () => {
  const output = redactDiagnostic({
    event: 'plan',
    sentItems: 7,
    remainingItems: 3,
    body: { aes_key: 'secret', count: 2 },
  }) as any;

  assert.equal(output.sentItems, 7);
  assert.equal(output.remainingItems, 3);
  assert.equal(output.body.aes_key, '***');
  assert.equal(output.body.count, 2);
});

test('recovery diagnostics keep metadata but never persist payloads or credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-recovery-diagnostics-'));
  const filePath = join(dir, 'delivery.jsonl');
  const diagnostics = new DeliveryDiagnostics(filePath);

  diagnostics.record({
    event: 'outbox-recovery',
    count: 2,
    failureKind: 'expired-before-delivery',
    ageMs: 300_000,
    attempt: 2,
    text: 'secret-message-body',
    token: 'secret-context-token',
    rawBody: { response: 'secret-raw-response' },
    payload: {
      text: 'nested-secret-message-body',
      credentials: { password: 'nested-secret-password' },
    },
  });

  const line = readFileSync(filePath, 'utf8').trim();
  const parsed = JSON.parse(line) as any;
  assert.equal(parsed.count, 2);
  assert.equal(parsed.failureKind, 'expired-before-delivery');
  assert.equal(parsed.ageMs, 300_000);
  assert.equal(parsed.attempt, 2);
  assert.equal(Object.hasOwn(parsed, 'text'), false);
  assert.equal(Object.hasOwn(parsed, 'token'), false);
  assert.equal(Object.hasOwn(parsed, 'rawBody'), false);
  assert.equal(Object.hasOwn(parsed, 'payload'), false);
  assert.ok(!line.includes('secret-message-body'));
  assert.ok(!line.includes('secret-context-token'));
  assert.ok(!line.includes('secret-raw-response'));
  assert.ok(!line.includes('nested-secret-message-body'));
  assert.ok(!line.includes('nested-secret-password'));
});

test('diagnostic filesystem failures never escape into message processing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-diagnostics-failure-'));
  const blockedParent = join(dir, 'not-a-directory');
  writeFileSync(blockedParent, 'file', 'utf8');
  const errors: unknown[] = [];

  let diagnostics: DeliveryDiagnostics | undefined;
  assert.doesNotThrow(() => {
    diagnostics = new DeliveryDiagnostics(join(blockedParent, 'delivery.jsonl'), {
      onError: (error) => errors.push(error),
    });
  });
  assert.doesNotThrow(() => diagnostics!.record({ event: 'inbound', userId: 'user-a' }));
  assert.equal(errors.length, 1);

  const directoryPath = join(dir, 'is-a-directory');
  mkdirSync(directoryPath);
  const appendErrors: unknown[] = [];
  const appendFailure = new DeliveryDiagnostics(directoryPath, {
    onError: (error) => appendErrors.push(error),
  });
  assert.doesNotThrow(() => appendFailure.record({ event: 'request' }));
  assert.equal(appendErrors.length, 1);
});
