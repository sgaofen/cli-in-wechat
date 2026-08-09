import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactSecrets, ILinkClient } from '../src/ilink/client.js';
import type { Credentials } from '../src/ilink/types.js';

// ─── redactSecrets: never leak decryption keys / signed URLs into logs ───────

test('redactSecrets: masks aes_key / encrypt_query_param / full_url / url', () => {
  const input = {
    type: 2,
    image_item: {
      media: {
        aes_key: 'VERYSECRETKEY==',
        encrypt_query_param: 'sig=abc&t=1',
        full_url: 'https://cdn/x?token=zzz',
        encrypt_type: 1,
      },
    },
  };
  const out = redactSecrets(input) as any;
  assert.equal(out.image_item.media.aes_key, '***');
  assert.equal(out.image_item.media.encrypt_query_param, '***');
  assert.equal(out.image_item.media.full_url, '***');
  assert.equal(out.image_item.media.encrypt_type, 1, 'non-secret fields preserved');
});

test('redactSecrets: recurses through arrays and preserves structure', () => {
  const input = [{ url: 'http://a' }, { text_item: { text: 'hello' } }];
  const out = redactSecrets(input) as any[];
  assert.equal(out[0].url, '***');
  assert.equal(out[1].text_item.text, 'hello');
});

test('redactSecrets: leaves empty/missing secret values untouched', () => {
  const out = redactSecrets({ aes_key: '' }) as any;
  assert.equal(out.aes_key, ''); // nothing to redact
});

test('redactSecrets: is case-insensitive on key names', () => {
  const out = redactSecrets({ AES_KEY: 'x', Full_Url: 'http://y' }) as any;
  assert.equal(out.AES_KEY, '***');
  assert.equal(out.Full_Url, '***');
});

// ─── isFreshMessage: long-poll re-delivery de-dup ────────────────────────────

const DUMMY_CREDS: Credentials = {
  botToken: 't', baseUrl: 'https://example.com', ilinkBotId: 'b', ilinkUserId: 'u',
};

function isolatedOptions() {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-internals-'));
  return {
    outboxPath: join(dir, 'outbox.json'),
    quotaPath: join(dir, 'quota.json'),
    diagnosticsPath: join(dir, 'delivery-diagnostics.jsonl'),
    contextTokensPath: join(dir, 'context_tokens.json'),
    pollCursorPath: join(dir, 'poll_cursor.txt'),
  };
}

test('isFreshMessage: first sighting true, replay false', () => {
  const client = new ILinkClient(DUMMY_CREDS, isolatedOptions()) as any;
  assert.equal(client.isFreshMessage('userA', 1001), true);
  assert.equal(client.isFreshMessage('userA', 1001), false);
  assert.equal(client.isFreshMessage('userA', 1002), true);
});

test('isFreshMessage: same numeric id from different users does NOT collide', () => {
  const client = new ILinkClient(DUMMY_CREDS, isolatedOptions()) as any;
  assert.equal(client.isFreshMessage('userA', 5), true);
  assert.equal(client.isFreshMessage('userB', 5), true, "userB's message 5 is not a dup of userA's");
  assert.equal(client.isFreshMessage('userA', 5), false);
});

test('isFreshMessage: evicts oldest beyond the 1000-entry cap but keeps recent ones', () => {
  const client = new ILinkClient(DUMMY_CREDS, isolatedOptions()) as any;
  for (let i = 0; i < 1000; i++) assert.equal(client.isFreshMessage('u', i), true);
  // Insert one more → the oldest key (u:0) is evicted.
  assert.equal(client.isFreshMessage('u', 1000), true);
  assert.equal(client.isFreshMessage('u', 0), true, 'evicted key is treated as fresh again');
  // A recently-seen key is still remembered.
  assert.equal(client.isFreshMessage('u', 999), false);
});

test('getUpdates stages its cursor until the full response batch is committed', async () => {
  const options = isolatedOptions();
  const client = new ILinkClient(DUMMY_CREDS, options) as any;
  const originalFetch = globalThis.fetch;
  client.pollCursor = 'cursor-before';
  globalThis.fetch = async () => new Response(JSON.stringify({
    ret: 0,
    msgs: [],
    get_updates_buf: 'cursor-after',
  }), { status: 200 });
  try {
    await client.getUpdates();
    assert.equal(client.pollCursor, 'cursor-before');
    assert.equal(client.pendingPollCursor, 'cursor-after');

    client.commitPendingPollCursor();
    assert.equal(client.pollCursor, 'cursor-after');
    assert.equal(readFileSync(options.pollCursorPath, 'utf8'), 'cursor-after');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed async handler leaves the inbound replayable until a successful retry', async () => {
  const options = isolatedOptions();
  const client = new ILinkClient(DUMMY_CREDS, options) as any;
  let attempts = 0;
  client.onMessage(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('handler failed');
  });
  const inbound = {
    message_id: 1,
    from_user_id: 'user-a',
    to_user_id: 'bot-user',
    client_id: 'inbound-client-1',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'context-a',
    item_list: [{ type: 1, text_item: { text: 'retry me' } }],
  };

  await assert.rejects(client.processMessage(inbound), /handler failed/);
  let persisted = JSON.parse(readFileSync(options.quotaPath, 'utf8')) as any;
  let state = persisted.users[`b\u0000user-a`];
  assert.deepEqual(state.pendingInboundIds, ['1']);
  assert.equal(state.seenInboundIds.includes('1'), false);

  await client.processMessage(inbound);
  persisted = JSON.parse(readFileSync(options.quotaPath, 'utf8')) as any;
  state = persisted.users[`b\u0000user-a`];
  assert.equal(attempts, 2);
  assert.deepEqual(state.pendingInboundIds, []);
  assert.equal(state.seenInboundIds.includes('1'), true);
  assert.equal(state.generation, 1);
});

test('an empty inbound is completed instead of remaining pending forever', async () => {
  const options = isolatedOptions();
  const client = new ILinkClient(DUMMY_CREDS, options) as any;

  await client.processMessage({
    message_id: 2,
    from_user_id: 'user-empty',
    to_user_id: 'bot-user',
    client_id: 'inbound-client-2',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'context-a',
    item_list: [],
  });

  const persisted = JSON.parse(readFileSync(options.quotaPath, 'utf8')) as any;
  const state = persisted.users[`b\u0000user-empty`];
  assert.deepEqual(state.pendingInboundIds, []);
  assert.equal(state.seenInboundIds.includes('2'), true);
});
