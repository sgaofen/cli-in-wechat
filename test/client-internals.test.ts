import test from 'node:test';
import assert from 'node:assert/strict';

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

test('isFreshMessage: first sighting true, replay false', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  assert.equal(client.isFreshMessage('userA', 1001), true);
  assert.equal(client.isFreshMessage('userA', 1001), false);
  assert.equal(client.isFreshMessage('userA', 1002), true);
});

test('isFreshMessage: same numeric id from different users does NOT collide', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  assert.equal(client.isFreshMessage('userA', 5), true);
  assert.equal(client.isFreshMessage('userB', 5), true, "userB's message 5 is not a dup of userA's");
  assert.equal(client.isFreshMessage('userA', 5), false);
});

test('isFreshMessage: evicts oldest beyond the 1000-entry cap but keeps recent ones', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  for (let i = 0; i < 1000; i++) assert.equal(client.isFreshMessage('u', i), true);
  // Insert one more → the oldest key (u:0) is evicted.
  assert.equal(client.isFreshMessage('u', 1000), true);
  assert.equal(client.isFreshMessage('u', 0), true, 'evicted key is treated as fresh again');
  // A recently-seen key is still remembered.
  assert.equal(client.isFreshMessage('u', 999), false);
});
