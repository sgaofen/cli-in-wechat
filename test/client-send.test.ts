import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ILinkClient } from '../src/ilink/client.js';
import { Router } from '../src/bridge/router.js';
import { OutboxStore } from '../src/ilink/outbox.js';
import { QuotaManager } from '../src/ilink/quota.js';
import { chunkUtf8Text } from '../src/ilink/text-chunk.js';
import type { Credentials, WeixinMessage } from '../src/ilink/types.js';
import {
  legacyFullChunkText,
  MIGRATED_BODY_BYTES,
  schemaTwoFailureFixture,
  schemaTwoMixedFailureFixture,
} from './fixtures/legacy-full-chunk.js';

const CREDS: Credentials = {
  botToken: 'token',
  baseUrl: 'https://example.test',
  ilinkBotId: 'account-a',
  ilinkUserId: 'bot-user',
};

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-'));
  return {
    outboxPath: join(dir, 'outbox.json'),
    quotaPath: join(dir, 'quota.json'),
    diagnosticsPath: join(dir, 'delivery-diagnostics.jsonl'),
    contextTokensPath: join(dir, 'context_tokens.json'),
  };
}

function message(id: number, uid = 'user-a', contextToken = 'context-token', text = 'hello'): WeixinMessage {
  return {
    message_id: id,
    from_user_id: uid,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function processInboundAndRecover(client: ILinkClient, inbound: WeixinMessage): Promise<void> {
  await (client as any).processMessage(inbound);
  await client.recoverPending(inbound.from_user_id);
}

async function withFetchResponses(
  bodies: Array<Record<string, unknown> | string>,
  run: (requests: any[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    const body = bodies.shift() ?? { ret: 0 };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('delivers thirteen queued final chunks as ten then three on the next inbound window', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      itemId: `final-${index + 1}`,
      text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 13 }, () => ({ ret: 0 })), async (requests) => {
    const first = await client.recoverPending('user-a');
    assert.equal(first.filter((result: any) => result.status === 'sent').length, 10);
    assert.equal(requests.length, 10);
    assert.equal(outbox.listPending('user-a').length, 3);

    await processInboundAndRecover(client, message(2));
    assert.equal(requests.length, 13);
    assert.equal(outbox.listPending('user-a').length, 0);
  });
});

test('processMessage lets the router wrap exact continuation recovery with typing', async () => {
  const client = new ILinkClient(CREDS, paths());
  const outbox = (client as any).outbox;
  outbox.enqueue({
    accountId: 'account-a',
    userId: 'user-a',
    generation: 1,
    tokenVersion: 1,
    priority: 'final',
    itemId: 'pending-1',
    text: 'queued body',
  });

  const events: string[] = [];
  (client as any).startTyping = async () => {
    events.push('typing:start');
    return () => events.push('typing:stop');
  };
  const router = new Router(client, {} as any, {} as any, {
    defaultTool: 'claude',
    maxResponseChunkSize: 2000,
    cliTimeout: 300_000,
    typingInterval: 5_000,
    allowedUsers: [],
    allowAllUsers: true,
    workDir: process.cwd(),
    tools: {},
  });
  let execCalled = false;
  (router as any).exec = async () => { execCalled = true; };
  client.onMessage((msg, text, refText, media) => (
    (router as any).handle(msg, text, refText, media)
  ));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    events.push('send:pending-1');
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await (client as any).processMessage(message(2, 'user-a', 'next-token', '继续'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(events, ['typing:start', 'send:pending-1', 'typing:stop']);
  assert.equal(execCalled, false);
  assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
});

test('preserves the incident-shaped mixed-priority queue in fifo order during migration', async () => {
  const options = paths();
  const snapshot = schemaTwoMixedFailureFixture();
  writeFileSync(options.outboxPath, JSON.stringify(snapshot), 'utf8');
  const client = new ILinkClient(CREDS, options);

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    await processInboundAndRecover(client, message(50, 'user-a', 'fresh-token', '继续'));

    assert.equal(requests.length, 10);
    const bodies = requests.map((request) => request.body.msg.item_list[0].text_item.text as string);
    const expectedBodies = [
      ...Array.from({ length: 9 }, (_, index) => `legacy-intermediate-${index + 1}`),
      'legacy-activity-1\n\n后续内容已排队，请回复“继续”续发。',
    ];
    assert.deepEqual(bodies, expectedBodies);
    assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 3_800));
    assert.ok(bodies[9].endsWith('\n\n后续内容已排队，请回复“继续”续发。'));
    assert.ok(!bodies.includes('后续内容已排队，请回复“继续”续发。'));

    const pending = client.getDeliveryStatus('user-a').pending;
    assert.deepEqual(pending.map((item) => item.itemId), [
      ...Array.from({ length: 18 }, (_, index) => `legacy-activity-${index + 2}`),
      ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
      'incident-control',
      'new-confirmation',
    ]);
    assert.equal(pending.filter((item) => item.priority === 'activity').length, 18);
    const confirmation = pending.find((item) => item.itemId === 'new-confirmation');
    assert.deepEqual(
      confirmation && {
        clientId: confirmation.clientId,
        generation: confirmation.generation,
        tokenVersion: confirmation.tokenVersion,
        priority: confirmation.priority,
        text: confirmation.text,
      },
      {
        clientId: 'new-confirmation-client',
        generation: 49,
        tokenVersion: 8,
        priority: 'final',
        text: '新会话',
      },
    );
    const control = pending.find((item) => item.itemId === 'incident-control');
    assert.deepEqual(
      control && {
        clientId: control.clientId,
        generation: control.generation,
        tokenVersion: control.tokenVersion,
        priority: control.priority,
        text: control.text,
      },
      {
        clientId: 'incident-control-client',
        generation: 41,
        tokenVersion: 6,
        priority: 'control',
        text: '保留控制消息',
      },
    );
    const persisted = JSON.parse(readFileSync(options.outboxPath, 'utf8'));
    assert.deepEqual(
      persisted.items.map((item: { itemId: string }) => item.itemId),
      pending.map((item) => item.itemId),
    );
  });
});

test('uses an injected quota window when migrating the default outbox', async () => {
  const options = paths();
  const snapshot = schemaTwoFailureFixture();
  snapshot.items = snapshot.items.slice(0, 8);
  snapshot.nextSequence = 9;
  writeFileSync(options.outboxPath, JSON.stringify(snapshot), 'utf8');
  const quota = new QuotaManager(options.quotaPath, 'account-a', { maxItemsPerWindow: 5 });
  const client = new ILinkClient(CREDS, { ...options, quota });

  await withFetchResponses(Array.from({ length: 5 }, () => ({ ret: 0 })), async (requests) => {
    await processInboundAndRecover(client, message(51, 'user-a', 'fresh-token', '继续'));

    assert.equal(requests.length, 5);
    const bodies = requests.map((request) => request.body.msg.item_list[0].text_item.text as string);
    assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 3_800));
    assert.ok(bodies[4].endsWith('\n\n后续内容已排队，请回复“继续”续发。'));
  });
});

test('drains twenty-five queued chunks as ten, ten, and five across inbound windows', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  for (let index = 0; index < 25; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `long-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 25 }, () => ({ ret: 0 })), async (requests) => {
    await client.recoverPending('user-a');
    assert.equal(requests.length, 10);
    await processInboundAndRecover(client, message(2));
    assert.equal(requests.length, 20);
    await processInboundAndRecover(client, message(3));
    assert.equal(requests.length, 25);
    assert.equal(outbox.listPending('user-a').length, 0);
  });
});

test('keeps all streamed body chunks ahead of a final footer across windows', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const continuationSuffixBytes = Buffer.byteLength(
    '\n\n后续内容已排队，请回复“继续”续发。',
    'utf8',
  );
  const bodyChunkBytes = 3_800 - continuationSuffixBytes;
  const body = 'A'.repeat(bodyChunkBytes * 13 + 500);
  const chunks = chunkUtf8Text(body, bodyChunkBytes);
  assert.equal(chunks.length, 14);

  await withFetchResponses(Array.from({ length: 15 }, () => ({ ret: 0 })), async (requests) => {
    await client.sendText('user-a', body, { streamType: 'intermediate', priority: 'intermediate' });
    assert.equal(requests.length, 10);
    assert.deepEqual(
      requests.slice(0, 9).map((request) => request.body.msg.item_list[0].text_item.text),
      chunks.slice(0, 9),
    );
    assert.equal(
      requests[9].body.msg.item_list[0].text_item.text,
      `${chunks[9]}\n\n后续内容已排队，请回复“继续”续发。`,
    );

    await client.sendText('user-a', '— Codex | 30.0s', { priority: 'final' });
    assert.deepEqual(
      client.getDeliveryStatus('user-a').pending.map((item) => item.text),
      [...chunks.slice(10), '— Codex | 30.0s'],
    );

    await processInboundAndRecover(client, message(2, 'user-a', 'next-token', '继续'));
    assert.deepEqual(
      requests.slice(10).map((request) => request.body.msg.item_list[0].text_item.text),
      [...chunks.slice(10), '— Codex | 30.0s'],
    );
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('ambiguous response keeps the frozen client id for the next recovery attempt', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  outbox.enqueue({
    accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
    priority: 'final', itemId: 'ambiguous-final', text: 'body',
  });

  await withFetchResponses([''], async (requests) => {
    const result = await client.recoverPending('user-a');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(outbox.listPending('user-a')[0].recoveryRequired, true);
    const firstClientId = requests[0].body.msg.client_id;

    await withFetchResponses([{ ret: 0 }], async (sameInboundRequests) => {
      await client.recoverPending('user-a');
      assert.equal(sameInboundRequests.length, 0);
      assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
    });

    await withFetchResponses([{ ret: 0 }], async (retryRequests) => {
      await processInboundAndRecover(client, message(2));
      assert.equal(retryRequests[0].body.msg.client_id, firstClientId);
      assert.equal(outbox.listPending('user-a').length, 0);
    });
  });
});

test('HTTP success with an iLink message_id confirms delivery when ret is omitted', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));

  await withFetchResponses([{ message_id: 12345 }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal((client as any).outbox.listPending('user-a').length, 0);
  });
});

test('default client sends UTF-8 text bodies above 2000 and at most 3800 bytes', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const body = '中文🙂'.repeat(1_000);

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    await client.sendText('user-a', body, { priority: 'final' });

    const requestBodies = requests.map(
      (request) => request.body.msg.item_list[0].text_item.text as string,
    );
    assert.ok(Buffer.byteLength(requestBodies[0], 'utf8') > 2_000);
    assert.ok(requestBodies.every((text) => Buffer.byteLength(text, 'utf8') <= 3_800));
    assert.equal(requestBodies.join(''), body);
  });
});

test('configured byte ceiling rechunks a short persisted pending batch before recovery', async () => {
  const options = paths();
  const snapshot = schemaTwoFailureFixture();
  const body = 'A'.repeat(1_500);
  snapshot.items = [{
    ...snapshot.items[0],
    text: body,
    bytes: Buffer.byteLength(body, 'utf8'),
  }];
  snapshot.nextSequence = 2;
  writeFileSync(options.outboxPath, JSON.stringify(snapshot), 'utf8');
  const client = new ILinkClient(CREDS, { ...options, maxTextBytes: 1_000 });

  await withFetchResponses(Array.from({ length: 2 }, () => ({ ret: 0 })), async (requests) => {
    await processInboundAndRecover(client, message(52, 'user-a', 'fresh-token', '继续'));

    const bodies = requests.map(
      (request) => request.body.msg.item_list[0].text_item.text as string,
    );
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((text) => Buffer.byteLength(text, 'utf8') <= 1_000));
    assert.equal(bodies.join(''), body);
  });
});

test('rate-limited ret=-2 stops the window without a second client retry', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'rate limited' }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'rate-limited');
    assert.equal(requests.length, 1);
    assert.equal((client as any).quota.snapshot('user-a').rateBackoffUntil > Date.now(), true);
  });
});

test('rate-limit cooldown automatically resumes pending text and success resets the streak', async () => {
  const client = new ILinkClient(CREDS, {
    ...paths(),
    rateLimitBaseCooldownMs: 10,
    rateLimitMaxCooldownMs: 10,
  });
  await (client as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'rate limited' }, { ret: 0 }], async (requests) => {
    const first = await client.sendText('user-a', 'body');
    assert.equal(first[0].status, 'rate-limited');

    const deadline = Date.now() + 1_000;
    while (requests.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(requests.length, 2);
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
    assert.equal((client as any).getRateLimitState('user-a').consecutiveRet2, 0);
  });
  client.stop();
});

test('restart after an expired cooldown immediately resumes the persisted pending text', async () => {
  const options = paths();
  const first = new ILinkClient(CREDS, {
    ...options,
    rateLimitBaseCooldownMs: 10,
    rateLimitMaxCooldownMs: 10,
  });
  await (first as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'rate limited' }], async () => {
    await first.sendText('user-a', 'body');
  });
  first.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));

  await withFetchResponses([{ ret: 0 }], async (requests) => {
    const restarted = new ILinkClient(CREDS, {
      ...options,
      rateLimitBaseCooldownMs: 10,
      rateLimitMaxCooldownMs: 10,
    });
    const deadline = Date.now() + 1_000;
    while (requests.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 1);
    assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
    restarted.stop();
  });
});

test('media sendmessage consumes the shared window budget', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, options);
  await (client as any).processMessage(message(1));
  (client as any).uploadToCdn = async () => ({
    rawsize: 6,
    filesize: 16,
    aeskey: Buffer.alloc(16),
    downloadParam: 'download-param',
  });
  let rawSendCalls = 0;
  let legacyRetryCalls = 0;
  (client as any).sendRawMessage = async () => { rawSendCalls += 1; };
  (client as any).sendRawMessageWithRetry = async () => { legacyRetryCalls += 1; };

  await client.sendFile('user-a', filePath);

  assert.equal(rawSendCalls, 1);
  assert.equal(legacyRetryCalls, 0);
  assert.equal(client.getDeliveryStatus('user-a').quota.sentItems, 1);
  assert.equal(client.getDeliveryStatus('user-a').quota.remainingItems, 9);
});

test('exhausted text budget blocks media before upload and sendmessage', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, options);
  await (client as any).processMessage(message(1));
  const quota = (client as any).quota as QuotaManager;
  for (let index = 0; index < 10; index += 1) {
    assert.equal(quota.confirmSend('user-a', `existing-${index}`), true);
  }
  let uploadCalls = 0;
  let sendCalls = 0;
  (client as any).uploadToCdn = async () => {
    uploadCalls += 1;
    throw new Error('must not upload');
  };
  (client as any).sendRawMessage = async () => { sendCalls += 1; };

  await assert.rejects(client.sendFile('user-a', filePath), /budget|quota|window/i);
  assert.equal(uploadCalls, 0);
  assert.equal(sendCalls, 0);
});

test('media HTTP 429 releases its reservation, enters cooldown, and does not retry', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, {
    ...options,
    rateLimitBaseCooldownMs: 1_000,
    rateLimitMaxCooldownMs: 1_000,
  });
  await (client as any).processMessage(message(1));
  (client as any).uploadToCdn = async () => ({
    rawsize: 6,
    filesize: 16,
    aeskey: Buffer.alloc(16),
    downloadParam: 'download-param',
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response('slow down', { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.sendFile('user-a', filePath), /429/);
    const quota = client.getDeliveryStatus('user-a').quota;
    assert.equal(requests, 1);
    assert.equal(quota.sentItems, 0);
    assert.equal(quota.reservedItems, 0);
    assert.equal(quota.rateBackoffUntil > Date.now(), true);
  } finally {
    globalThis.fetch = originalFetch;
    client.stop();
  }
});

test('media transport ambiguity makes exactly one sendmessage request', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, options);
  await (client as any).processMessage(message(1));
  (client as any).uploadToCdn = async () => ({
    rawsize: 6,
    filesize: 16,
    aeskey: Buffer.alloc(16),
    downloadParam: 'download-param',
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    const error = new Error('connection reset') as NodeJS.ErrnoException;
    error.code = 'ECONNRESET';
    throw error;
  }) as typeof fetch;
  try {
    await assert.rejects(client.sendFile('user-a', filePath), /ECONNRESET|连接被重置/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media upload ambiguity does not consume the sendmessage budget', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, options);
  await (client as any).processMessage(message(1));
  let sendCalls = 0;
  (client as any).uploadToCdn = async () => {
    const error = new Error('upload connection reset') as NodeJS.ErrnoException;
    error.code = 'ECONNRESET';
    throw error;
  };
  (client as any).sendRawMessage = async () => { sendCalls += 1; };

  await assert.rejects(client.sendFile('user-a', filePath), /upload connection reset/);

  const quota = client.getDeliveryStatus('user-a').quota;
  assert.equal(sendCalls, 0);
  assert.equal(quota.sentItems, 0);
  assert.equal(quota.reservedItems, 0);
  assert.equal(quota.rateBackoffUntil, 0);
});

test('media ret=-2 without errmsg is ambiguous without entering cooldown', async () => {
  const options = paths();
  const filePath = join(dirname(options.outboxPath), 'report.txt');
  writeFileSync(filePath, 'report', 'utf8');
  const client = new ILinkClient(CREDS, options);
  await (client as any).processMessage(message(1));
  (client as any).uploadToCdn = async () => ({
    rawsize: 6,
    filesize: 16,
    aeskey: Buffer.alloc(16),
    downloadParam: 'download-param',
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ ret: -2 }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.sendFile('user-a', filePath), /ret=-2/);
    const quota = client.getDeliveryStatus('user-a').quota;
    assert.equal(requests, 1);
    assert.equal(quota.sentItems, 1);
    assert.equal(quota.reservedItems, 0);
    assert.equal(quota.rateBackoffUntil, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rate-limited boundary retry removes the stale continuation notice', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  for (let index = 0; index < 11; index += 1) {
    outbox.enqueue({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      itemId: `rate-boundary-${index + 1}`,
      text: `body-${index + 1}`,
    });
  }

  const responses = [
    ...Array.from({ length: 9 }, () => ({ ret: 0 })),
    { ret: -2, errmsg: 'rate limited' },
    { ret: 0 },
    { ret: 0 },
  ];
  await withFetchResponses(responses, async (requests) => {
    await client.recoverPending('user-a');
    await processInboundAndRecover(client, message(2, 'user-a', 'next-token', '继续'));

    const bodies = requests.map(
      (request) => request.body.msg.item_list[0].text_item.text as string,
    );
    assert.ok(bodies[9].endsWith('\n\n后续内容已排队，请回复“继续”续发。'));
    assert.equal(bodies[10], 'body-10');
    assert.equal(bodies[11], 'body-11');
    assert.equal(outbox.listPending('user-a').length, 0);
  });
});

test('activity holdback preserves fifo order when the final result arrives', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    for (let index = 0; index < 10; index += 1) {
      await client.sendText('user-a', `activity-${index + 1}`, { priority: 'activity' });
    }
    assert.equal(requests.length, 9);
    assert.equal(requests[8].body.msg.item_list[0].text_item.text, 'activity-9');

    await client.sendText('user-a', 'final-result', { priority: 'final' });
    assert.equal(requests.length, 10);
    assert.equal(
      requests[9].body.msg.item_list[0].text_item.text,
      'activity-10\n\n后续内容已排队，请回复“继续”续发。',
    );
    assert.deepEqual(client.getDeliveryStatus('user-a').pending.map((item) => item.text), [
      'final-result',
    ]);

    await processInboundAndRecover(client, message(2, 'user-a', 'next-token', '继续'));
    assert.deepEqual(
      requests.slice(10).map((request) => request.body.msg.item_list[0].text_item.text),
      ['final-result'],
    );
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('configured window size limits delivery and leaves the suffix durable', async () => {
  const client = new ILinkClient(CREDS, { ...paths(), maxItemsPerWindow: 3 });
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox as OutboxStore;
  for (let index = 0; index < 5; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `configured-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 5 }, () => ({ ret: 0 })), async (requests) => {
    await client.recoverPending('user-a');
    assert.equal(requests.length, 3);
    assert.equal(client.getDeliveryStatus('user-a').quota.sentItems, 3);
    assert.equal(client.getDeliveryStatus('user-a').quota.maxItemsPerWindow, 3);
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 2);
  });
});

test('a fresh inbound during an in-flight confirmed send does not relabel it ambiguous', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const originalFetch = globalThis.fetch;
  let releaseResponse!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  globalThis.fetch = (async () => {
    markStarted();
    await responseGate;
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    const sending = client.sendText('user-a', 'confirmed old generation');
    await started;
    const nextInbound = (client as any).processMessage(message(2));
    releaseResponse();

    const result = await sending;
    await nextInbound;
    assert.equal(result[0].status, 'sent');
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-rate ret=-2 is ambiguous and remains durable for recovery', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'temporary scheduler failure' }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(requests.length, 1);
    assert.equal((client as any).outbox.listPending('user-a')[0].recoveryRequired, true);
  });
});

test('HTTP 400 permanently fails only the bad item and unblocks the FIFO suffix', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox as OutboxStore;
  for (const [itemId, text] of [['bad-item', 'bad'], ['good-item', 'good']] as const) {
    outbox.enqueue({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      itemId,
      text,
    });
  }
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1
      ? new Response('invalid payload', { status: 400 })
      : new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await client.recoverPending('user-a');
    assert.equal(first[0].status, 'permanent-failure');
    await client.recoverPending('user-a');

    assert.equal(requests, 2);
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
    assert.deepEqual(client.getDeliveryStatus('user-a').failed.map((item) => item.itemId), ['bad-item']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unconfirmed transport failure becomes ambiguous without an immediate retry', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' });
  }) as typeof fetch;
  try {
    const result = await client.sendText('user-a', 'ambiguous transport');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(requests, 1);
    assert.equal(client.getDeliveryStatus('user-a').pending[0].recoveryRequired, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing context token queues text without making a network request', async () => {
  const client = new ILinkClient(CREDS, paths());
  await withFetchResponses([], async (requests) => {
    const result = await client.sendText('user-a', 'queued body');
    assert.equal(result[0].status, 'waiting-for-token');
    assert.equal(requests.length, 0);
    assert.equal((client as any).outbox.listPending('user-a').length, 1);
  });
});

test('sendText preserves an explicit task generation and exposes waiting state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-injected-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a');
  const client = new ILinkClient(CREDS, {
    outbox,
    quota,
    contextTokensPath: join(dir, 'context_tokens.json'),
    diagnosticsPath: join(dir, 'diagnostics.jsonl'),
  });

  const result = await client.sendText('user-a', 'durable task', { generation: 42, priority: 'final' });

  assert.equal(result[0].status, 'waiting-for-token');
  assert.equal(outbox.listPending('user-a')[0].generation, 42);
  assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
});

test('a fresh inbound without a context token keeps the last usable token', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1, 'user-a', 'token-a'));
  await (client as any).processMessage(message(2, 'user-a', ''));

  assert.equal(client.getContextToken('user-a'), 'token-a');
});

test('restart after the seventh confirmed chunk resumes the ambiguous item with the same client id', async () => {
  const options = paths();
  const first = new ILinkClient(CREDS, options);
  await (first as any).processMessage(message(1));
  const outbox = (first as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `restart-seven-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  const responses = [
    ...Array.from({ length: 7 }, () => ({ ret: 0 })),
    '',
    ...Array.from({ length: 6 }, () => ({ ret: 0 })),
  ];
  await withFetchResponses(responses, async (requests) => {
    const firstResult = await first.recoverPending('user-a');
    assert.equal(firstResult.filter((result) => result.status === 'sent').length, 7);
    assert.equal(firstResult.at(-1)?.status, 'ambiguous');
    const ambiguousClientId = requests[7].body.msg.client_id;

    const restarted = new ILinkClient(CREDS, options);
    await processInboundAndRecover(restarted, message(2));
    assert.equal(requests[8].body.msg.client_id, ambiguousClientId);
    assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('restart after the tenth confirmed chunk resumes the remaining three', async () => {
  const options = paths();
  const first = new ILinkClient(CREDS, options);
  await (first as any).processMessage(message(1));
  const outbox = (first as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `restart-ten-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 13 }, () => ({ ret: 0 })), async (requests) => {
    await first.recoverPending('user-a');
    assert.equal(requests.length, 10);
    const restarted = new ILinkClient(CREDS, options);
    await processInboundAndRecover(restarted, message(2));
    assert.equal(requests.length, 13);
    assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('restart reconciles a durable delivery receipt without resending', async () => {
  const options = paths();
  const outbox = new OutboxStore(options.outboxPath);
  const quota = new QuotaManager(options.quotaPath, 'account-a');
  const first = new ILinkClient(CREDS, { ...options, outbox, quota });
  await (first as any).processMessage(message(1));

  const commitDelivery = quota.commitDelivery.bind(quota);
  let simulateCrash = true;
  quota.commitDelivery = ((confirmation) => {
    if (simulateCrash) {
      simulateCrash = false;
      throw new Error('simulated crash before quota persistence');
    }
    return commitDelivery(confirmation);
  }) as typeof quota.commitDelivery;

  await withFetchResponses([{ ret: 0 }], async (requests) => {
    await assert.rejects(
      first.sendText('user-a', 'confirmed before crash'),
      (err: any) => err?.deliveryConfirmed === true
        && /simulated crash before quota persistence/.test(String(err.cause)),
    );
    assert.equal(requests.length, 1);
  });
  assert.ok(outbox.listPending('user-a')[0]?.deliveryReceipt);

  const restarted = new ILinkClient(CREDS, options);
  await withFetchResponses([], async (requests) => {
    await restarted.recoverPending('user-a');
    assert.equal(requests.length, 0);
  });
  assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  assert.equal(restarted.getDeliveryStatus('user-a').quota.sentItems, 1);
  assert.equal(restarted.getDeliveryStatus('user-a').quota.remainingItems, 9);
});
