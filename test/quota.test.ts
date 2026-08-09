import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaManager } from '../src/ilink/quota.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quota-v2-state-')), 'quota.json');
}

test('opens a ten-item window only for a fresh inbound and counts confirmed sends', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  const first = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(first.duplicate, false);
  assert.equal(first.generation, 1);
  assert.equal(first.tokenVersion, 1);
  assert.equal(quota.remaining('user-a'), 10);

  quota.confirmSend('user-a', 'item-1');
  quota.confirmSend('user-a', 'item-2');
  assert.equal(quota.remaining('user-a'), 8);

  const duplicate = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.generation, 1);
  assert.equal(quota.remaining('user-a'), 8);
});

test('normalizes finite delivery window limits by flooring and clamping to one', () => {
  for (const [configured, expected] of [[3.5, 3], [0, 1], [-1, 1]] as const) {
    const quota = new QuotaManager(tempPath(), 'account-a', { maxItemsPerWindow: configured });
    assert.equal(quota.snapshot('user-a').maxItemsPerWindow, expected);
  }
});

test('falls back to the default delivery window for non-finite limits', () => {
  for (const configured of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const quota = new QuotaManager(tempPath(), 'account-a', { maxItemsPerWindow: configured });
    assert.equal(quota.snapshot('user-a').maxItemsPerWindow, 10);
  }
});

test('exposes the effective delivery window without creating user state', () => {
  const quota = new QuotaManager(tempPath(), 'account-a', { maxItemsPerWindow: 3.5 });

  assert.equal((quota as any).users.size, 0);
  assert.equal(quota.getMaxItemsPerWindow(), 3);
  assert.equal((quota as any).users.size, 0);
  assert.equal(quota.snapshot('user-a').maxItemsPerWindow, quota.getMaxItemsPerWindow());
});

test('a real inbound opens the next window while a poll replay does not', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  for (let index = 0; index < 10; index += 1) quota.confirmSend('user-a', `item-${index}`);
  assert.equal(quota.remaining('user-a'), 0);

  const replay = quota.recordInbound('user-a', 1, 'token-1');
  assert.equal(replay.duplicate, true);
  assert.equal(quota.remaining('user-a'), 0);

  const next = quota.recordInbound('user-a', 2, 'token-1');
  assert.equal(next.duplicate, false);
  assert.equal(next.generation, 2);
  assert.equal(quota.remaining('user-a'), 10);
});

test('an incomplete inbound retries without opening a second quota window', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  const first = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(first.duplicate, false);
  assert.equal(first.generation, 1);

  assert.equal(quota.abandonInbound('user-a', 'message-1'), true);
  const retry = quota.recordInbound('user-a', 'message-1', 'token-1');
  assert.equal(retry.duplicate, false);
  assert.equal(retry.generation, 1);

  assert.equal(quota.completeInbound('user-a', 'message-1'), true);
  assert.equal(quota.recordInbound('user-a', 'message-1', 'token-1').duplicate, true);
});

test('confirmed item IDs are idempotent and do not overrun the window', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  assert.equal(quota.confirmSend('user-a', 'item-1'), true);
  assert.equal(quota.confirmSend('user-a', 'item-1'), false);
  assert.equal(quota.remaining('user-a'), 9);
});

test('restart preserves the current budget and token version', () => {
  const filePath = tempPath();
  const first = new QuotaManager(filePath, 'account-a');
  first.recordInbound('user-a', 1, 'token-1');
  first.confirmSend('user-a', 'item-1');

  const restarted = new QuotaManager(filePath, 'account-a');
  assert.equal(restarted.remaining('user-a'), 9);
  assert.equal(restarted.snapshot('user-a').tokenVersion, 1);
});

test('reconciles a confirmed delivery after restart exactly once', () => {
  const filePath = tempPath();
  const first = new QuotaManager(filePath, 'account-a');
  first.recordInbound('user-a', 1, 'token-1');
  const reserved = first.reserve('user-a', 12, 'final');
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;

  const confirmation = {
    reservationId: reserved.reservation.reservationId,
    userId: 'user-a',
    itemId: 'confirmed-after-restart',
    quotaGeneration: first.snapshot('user-a').generation,
    bytes: 12,
  };
  const restarted = new QuotaManager(filePath, 'account-a');

  assert.equal(restarted.commitDelivery(confirmation), true);
  assert.equal(restarted.commitDelivery(confirmation), false);
  assert.equal(restarted.snapshot('user-a').sentItems, 1);
  assert.equal(restarted.snapshot('user-a').sentBytes, 12);
  assert.equal(restarted.remaining('user-a'), 9);
});

test('a failed delivery commit write can be retried in the same process', () => {
  const filePath = tempPath();
  const quota = new QuotaManager(filePath, 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  const reserved = quota.reserve('user-a', 12, 'final');
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;

  const confirmation = {
    reservationId: reserved.reservation.reservationId,
    userId: 'user-a',
    itemId: 'retry-after-write-failure',
    quotaGeneration: quota.snapshot('user-a').generation,
    bytes: 12,
  };
  const persist = (quota as any).persist.bind(quota);
  let failOnce = true;
  (quota as any).persist = () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated quota write failure');
    }
    persist();
  };

  assert.throws(() => quota.commitDelivery(confirmation), /simulated quota write failure/);
  assert.equal(quota.commitDelivery(confirmation), true);

  const restarted = new QuotaManager(filePath, 'account-a');
  assert.equal(restarted.snapshot('user-a').sentItems, 1);
  assert.equal(restarted.snapshot('user-a').remainingItems, 9);
});

test('token changes are recorded but do not reset quota without a fresh inbound', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  quota.confirmSend('user-a', 'item-1');
  const duplicateWithNewToken = quota.recordInbound('user-a', 1, 'token-2');
  assert.equal(duplicateWithNewToken.duplicate, true);
  assert.equal(duplicateWithNewToken.tokenVersion, 1);
  assert.equal(quota.remaining('user-a'), 9);

  const next = quota.recordInbound('user-a', 2, 'token-2');
  assert.equal(next.tokenVersion, 2);
  assert.equal(quota.remaining('user-a'), 10);
});

test('two users have independent windows and rate backoff state', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-a');
  quota.recordInbound('user-b', 1, 'token-b');
  quota.confirmSend('user-a', 'item-a');
  quota.markRateBackoff('user-a', 60_000);

  assert.equal(quota.remaining('user-a'), 9);
  assert.equal(quota.remaining('user-b'), 10);
  assert.equal(quota.snapshot('user-a').rateBackoffUntil > Date.now(), true);
  assert.equal(quota.snapshot('user-b').rateBackoffUntil, 0);
});

test('holds one live-stream slot for a discoverable continuation boundary', () => {
  const quota = new QuotaManager(tempPath(), 'account-a', {
    maxItems: 3,
    maxBytes: 32,
    finalReserveItems: 1,
    finalReserveBytes: 16,
  });
  quota.recordInbound('user-a', 1, 'token-1');

  const intermediate = quota.reserve('user-a', 8, 'intermediate');
  assert.equal(intermediate.allowed, true);
  const activity = quota.reserve('user-a', 8, 'activity');
  assert.equal(activity.allowed, true);
  const blocked = quota.reserve('user-a', 1, 'activity');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'final-reserved');

  const final = quota.reserve('user-a', 16, 'final');
  assert.equal(final.allowed, true);
  assert.equal(quota.commit(final.reservation.reservationId), true);
  assert.equal(quota.release(intermediate.reservation.reservationId), true);
  assert.equal(quota.release(activity.reservation.reservationId), true);
  assert.equal(quota.snapshot('user-a').reservedItems, 0);
  assert.equal(quota.snapshot('user-a').sentItems, 1);
});

test('default quota allows streamed records to use all ten item slots', () => {
  const quota = new QuotaManager(tempPath(), 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');

  for (let index = 0; index < 10; index += 1) {
    assert.equal(quota.reserve('user-a', 1, 'activity').allowed, true);
  }
  const blocked = quota.reserve('user-a', 1, 'activity');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'intermediate-budget');
});

test('enforces stream holdbacks and preserves explicit reservation context', () => {
  const quota = new QuotaManager(tempPath(), 'account-a', {
    maxItemsPerWindow: 5,
    finalReserveItems: 0,
    maxIntermediateItemsPerToken: 2,
    finalReserveItemsPerToken: 2,
  });
  quota.recordInbound('user-a', 1, 'token-1');

  const first = quota.reserve('user-a', 1, 'activity', { generation: 42, tokenVersion: 9 });
  assert.equal(first.allowed, true);
  assert.equal(first.reservation.generation, 42);
  assert.equal(first.reservation.tokenVersion, 9);
  const second = quota.reserve('user-a', 1, 'intermediate');
  assert.equal(second.allowed, true);
  const blockedIntermediate = quota.reserve('user-a', 1, 'activity');
  assert.equal(blockedIntermediate.allowed, false);
  assert.equal(blockedIntermediate.reason, 'intermediate-budget');

  quota.release(first.reservation.reservationId);
  quota.release(second.reservation.reservationId);
  const mediaOne = quota.reserve('user-a', 1, 'media');
  const mediaTwo = quota.reserve('user-a', 1, 'media');
  const mediaThree = quota.reserve('user-a', 1, 'media');
  const blockedMedia = quota.reserve('user-a', 1, 'media');
  assert.equal(mediaOne.allowed, true);
  assert.equal(mediaTwo.allowed, true);
  assert.equal(mediaThree.allowed, true);
  assert.equal(blockedMedia.allowed, false);
  assert.equal(blockedMedia.reason, 'final-reserved');
});

test('rate backoff aliases persist and clear only when the context token changes', () => {
  const filePath = tempPath();
  const quota = new QuotaManager(filePath, 'account-a');
  quota.recordInbound('user-a', 1, 'token-1');
  const until = Date.now() + 60_000;
  quota.noteRateBackoff('user-a', until);

  const restarted = new QuotaManager(filePath, 'account-a');
  assert.equal(restarted.getRateBackoff('user-a').until, until);
  restarted.recordInbound('user-a', 2, 'token-1');
  assert.equal(restarted.getRateBackoff('user-a').until, until);
  restarted.recordInbound('user-a', 3, 'token-2');
  assert.equal(restarted.getRateBackoff('user-a').until, 0);
});

test('preserves another account when managers share one quota file', () => {
  const filePath = tempPath();
  const first = new QuotaManager(filePath, 'account-a');
  first.recordInbound('user-a', 1, 'token-a');
  first.confirmSend('user-a', 'item-a');

  const second = new QuotaManager(filePath, 'account-b');
  second.recordInbound('user-b', 1, 'token-b');

  const reloaded = new QuotaManager(filePath, 'account-a');
  assert.equal(reloaded.snapshot('user-a').sentItems, 1);
});

test('interleaved account writes do not erase newer foreign quota state', () => {
  const filePath = tempPath();
  const first = new QuotaManager(filePath, 'account-a');
  const second = new QuotaManager(filePath, 'account-b');
  first.recordInbound('user-a', 1, 'token-a');
  second.recordInbound('user-b', 1, 'token-b');

  first.confirmSend('user-a', 'item-a');

  const reloaded = new QuotaManager(filePath, 'account-b');
  assert.equal(reloaded.snapshot('user-b').generation, 1);
});
