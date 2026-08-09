import test from 'node:test';
import assert from 'node:assert/strict';

import { planDeliveryWindow } from '../src/ilink/delivery-planner.js';

test('plans thirteen final chunks as ten now and three later', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: Buffer.byteLength(`chunk-${index + 1}`, 'utf8'),
  }));

  const first = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 10,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  });

  assert.deepEqual(
    first.items.map((item) => item.itemId),
    Array.from({ length: 10 }, (_, i) => `item-${i + 1}`),
  );
  assert.equal(first.items.at(-1)?.text.endsWith('后续内容已排队，请回复“继续”续发。'), true);
  assert.equal(first.remainingItems, 3);
});

test('drains twenty-five chunks as ten, ten, and five', () => {
  let pending = Array.from({ length: 25 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: Buffer.byteLength(`chunk-${index + 1}`, 'utf8'),
  }));
  const windows: number[] = [];

  while (pending.length > 0) {
    const plan = planDeliveryWindow(pending, {
      sentItems: 0,
      maxItems: 10,
      continuationNotice: '续发',
    });
    windows.push(plan.items.length);
    pending = pending.slice(plan.items.length);
  }

  assert.deepEqual(windows, [10, 10, 5]);
});

test('does not append a continuation notice when exactly ten items finish the queue', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: 7,
  }));

  const plan = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 10,
    continuationNotice: '续发',
  });

  assert.equal(plan.remainingItems, 0);
  assert.equal(plan.needsContinuation, false);
  assert.equal(plan.items.at(-1)?.text, 'chunk-10');
});

test('keeps the continuation notice within the UTF-8 byte limit', () => {
  const items = [
    { itemId: 'item-1', text: '正文', priority: 'final' as const, bytes: Buffer.byteLength('正文', 'utf8') },
    { itemId: 'item-2', text: '结尾', priority: 'final' as const, bytes: Buffer.byteLength('结尾', 'utf8') },
  ];

  const plan = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 1,
    maxBytes: 80,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  });

  assert.equal(plan.needsContinuation, true);
  assert.ok(Buffer.byteLength(plan.items[0].text, 'utf8') <= 80);
  assert.ok(plan.items[0].text.endsWith('后续内容已排队，请回复“继续”续发。'));
});

test('preserves fifo order across mixed priorities', () => {
  const plan = planDeliveryWindow([
    { itemId: 'activity-1', text: 'activity', priority: 'activity', bytes: 8 },
    { itemId: 'final-1', text: 'final', priority: 'final', bytes: 5 },
    { itemId: 'intermediate-1', text: 'answer', priority: 'intermediate', bytes: 6 },
  ], { sentItems: 0, maxItems: 2, continuationNotice: '续发' });

  assert.deepEqual(plan.items.map((item) => item.itemId), ['activity-1', 'final-1']);
  assert.equal(plan.remainingItems, 1);
  assert.equal(plan.items[1].text, 'final\n\n续发');
});

test('returns an empty window when no inbound budget remains', () => {
  const plan = planDeliveryWindow([
    { itemId: 'item-1', text: 'body', priority: 'final', bytes: 4 },
  ], { sentItems: 10, maxItems: 10, continuationNotice: '续发' });

  assert.deepEqual(plan.items, []);
  assert.equal(plan.remainingItems, 1);
  assert.equal(plan.needsContinuation, true);
});

test('covers the required final chunk counts at the ten-item boundary', () => {
  for (const count of [1, 9, 10, 11, 13, 20, 25]) {
    const items = Array.from({ length: count }, (_, index) => ({
      itemId: `${count}-${index}`,
      text: `chunk-${index}`,
      priority: 'final' as const,
      bytes: 7,
    }));
    const plan = planDeliveryWindow(items, {
      sentItems: 0,
      maxItems: 10,
      continuationNotice: '续发',
    });
    assert.equal(plan.items.length, Math.min(count, 10), `count=${count}`);
    assert.equal(plan.remainingItems, Math.max(0, count - 10), `count=${count}`);
    assert.equal(plan.needsContinuation, count > 10, `count=${count}`);
  }
});

test('holds an unresolved tenth streamed record without closing the window early', () => {
  const plan = planDeliveryWindow(Array.from({ length: 10 }, (_, index) => ({
    itemId: `activity-${index + 1}`,
    text: `activity-${index + 1}`,
    priority: 'activity' as const,
    bytes: 10,
  })), {
    sentItems: 0,
    maxItems: 10,
    maxItemsByPriority: { activity: 10, intermediate: 10 },
    continuationNotice: '续发',
  });

  assert.equal(plan.items.length, 9);
  assert.equal(plan.remainingItems, 1);
  assert.equal(plan.needsContinuation, false);
  assert.equal(plan.items[8].text, 'activity-9');
});

test('uses the tenth slot when a later final proves the streaming boundary', () => {
  const items = [
    ...Array.from({ length: 10 }, (_, index) => ({
      itemId: `activity-${index + 1}`,
      text: `activity-${index + 1}`,
      priority: 'activity' as const,
      bytes: 11,
    })),
    { itemId: 'final-1', text: 'footer', priority: 'final' as const, bytes: 6 },
  ];

  const plan = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 10,
    maxItemsByPriority: { activity: 10, intermediate: 10 },
    continuationNotice: '续发',
  });

  assert.deepEqual(
    plan.items.map((item) => item.itemId),
    Array.from({ length: 10 }, (_, index) => `activity-${index + 1}`),
  );
  assert.equal(plan.items[9].text, 'activity-10\n\n续发');
  assert.equal(plan.remainingItems, 1);
  assert.equal(plan.needsContinuation, true);
});

test('lets a terminal final fill the tenth slot without a continuation notice', () => {
  const items = [
    ...Array.from({ length: 9 }, (_, index) => ({
      itemId: `activity-${index + 1}`,
      text: `activity-${index + 1}`,
      priority: 'activity' as const,
      bytes: 11,
    })),
    { itemId: 'final-1', text: 'footer', priority: 'final' as const, bytes: 6 },
  ];

  const plan = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 10,
    maxItemsByPriority: { activity: 10, intermediate: 10 },
    continuationNotice: '续发',
  });

  assert.equal(plan.items.length, 10);
  assert.equal(plan.items[9].text, 'footer');
  assert.equal(plan.remainingItems, 0);
  assert.equal(plan.needsContinuation, false);
});
