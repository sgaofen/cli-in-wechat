import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OutboxCapacityError,
  OutboxMigrationError,
  OutboxStore,
  type OutboxItem,
} from '../src/ilink/outbox.js';
import { planDeliveryWindow, type DeliveryItem } from '../src/ilink/delivery-planner.js';
import {
  INBOUND_WINDOW_ITEMS,
  MIGRATED_BODY_BYTES,
  legacyFullChunkText,
  schemaOneLegacyFullChunkFixture,
  schemaTwoFailureFixture,
  schemaTwoMixedFailureFixture,
} from './fixtures/legacy-full-chunk.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quota-v2-outbox-')), 'outbox.json');
}

function input(overrides: Partial<OutboxItem> = {}) {
  return {
    accountId: 'account-a',
    userId: 'user-a',
    generation: 1,
    tokenVersion: 1,
    priority: 'final' as const,
    text: 'frozen body',
    ...overrides,
  };
}

function migrationOptions() {
  return {
    bodyChunkBytes: MIGRATED_BODY_BYTES,
    inboundItemLimit: INBOUND_WINDOW_ITEMS,
  };
}

function assertSafePersistedSequences(filePath: string): void {
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  const sequences = persisted.items.map((item: OutboxItem) => item.sequence) as number[];
  assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index] > sequences[index - 1]);
  }
  assert.ok(Number.isSafeInteger(persisted.nextSequence));
  assert.ok(persisted.nextSequence > Math.max(...sequences));
}

function stableMigrationFields(item: Record<string, unknown> | OutboxItem) {
  return {
    accountId: item.accountId,
    userId: item.userId,
    generation: item.generation,
    tokenVersion: item.tokenVersion,
    priority: item.priority,
    text: item.text,
    bytes: item.bytes,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    state: item.state,
    itemId: item.itemId,
    clientId: item.clientId,
  };
}

function assertMigrationRejectedWithoutWrite(filePath: string, original: string): void {
  assert.throws(
    () => new OutboxStore(filePath, migrationOptions()),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /^outbox migration failed: /);
      return true;
    },
  );
  assert.equal(readFileSync(filePath, 'utf8'), original);
  assert.equal(existsSync(`${filePath}.bak`), false);
}

test('freezes text and client id before send and reloads them after restart', () => {
  const filePath = tempPath();
  const first = new OutboxStore(filePath);
  const created = first.enqueue(input({ itemId: 'final-1' }));
  assert.equal(created.text, 'frozen body');
  assert.ok(created.clientId);

  const restarted = new OutboxStore(filePath);
  const loaded = restarted.listPending('user-a')[0];
  assert.equal(loaded.itemId, 'final-1');
  assert.equal(loaded.text, 'frozen body');
  assert.equal(loaded.clientId, created.clientId);
  assert.equal(restarted.ack('final-1'), true);
  assert.deepEqual(restarted.listPending('user-a'), []);
});

test('persists a confirmed delivery receipt until quota reconciliation', () => {
  const filePath = tempPath();
  const first = new OutboxStore(filePath);
  const item = first.enqueue(input({ itemId: 'confirmed-1' }));

  assert.equal(first.recordDeliveryReceipt(item.itemId, 'reservation-1', 3), true);

  const restarted = new OutboxStore(filePath);
  assert.deepEqual(restarted.get(item.itemId)?.deliveryReceipt, {
    reservationId: 'reservation-1',
    quotaGeneration: 3,
  });
});

test('ambiguous records become terminal without losing identity or payload', () => {
  const now = 1_000;
  const store = new OutboxStore(tempPath(), { now: () => now });
  const created = store.enqueue(input({ itemId: 'ambiguous-1' }));

  assert.equal(store.markAmbiguous('ambiguous-1', { errmsg: 'timeout' }), true);
  const failed = store.get('ambiguous-1');
  assert.equal(store.listPending('user-a').length, 0);
  assert.equal(failed?.clientId, created.clientId);
  assert.equal(failed?.text, created.text);
  assert.equal(failed?.state, 'permanent-failure');
  assert.equal(failed?.failureKind, 'ambiguous-delivery');
  assert.equal(failed?.failedAt, now);
  assert.equal(failed?.recoveryAttempts, 0);
  assert.equal(failed?.recoveryRequired, false);
  assert.deepEqual(failed?.terminalError, { errmsg: 'timeout' });
});

test('final enqueue preserves same-generation activity and intermediate records in fifo order', () => {
  const store = new OutboxStore(tempPath());
  store.enqueue(input({ itemId: 'activity-1', priority: 'activity', text: 'activity' }));
  store.enqueue(input({ itemId: 'intermediate-1', priority: 'intermediate', text: 'intermediate' }));
  store.enqueue(input({ itemId: 'final-1', priority: 'final', text: 'final' }));

  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [
    'activity-1',
    'intermediate-1',
    'final-1',
  ]);
});

test('final enqueue preserves confirmed activity until its receipt is reconciled', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 2 });
  const activity = store.enqueue(input({ itemId: 'confirmed-activity', priority: 'activity' }));
  store.recordDeliveryReceipt(activity.itemId, 'reservation-1', 1);

  store.enqueue(input({ itemId: 'final-1', text: 'final body' }));

  assert.equal(store.get(activity.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
  assert.equal(store.get('final-1')?.state, 'pending');
});

test('does not silently evict final items when capacity is exhausted', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1, maxBytesPerUser: 100 });
  store.enqueue(input({ itemId: 'final-1' }));

  assert.throws(
    () => store.enqueue(input({ itemId: 'final-2', text: 'another final' })),
    OutboxCapacityError,
  );
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['final-1']);
});

test('terminal failures do not consume active item or byte capacity', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 1,
    maxBytesPerUser: 12,
    maxFailedItemsPerUser: 10,
    maxFailedBytesPerUser: 1_000,
  });
  const failed = store.enqueue(input({ itemId: 'failed-final', text: 'old failure' }));
  store.markPermanentFailure(
    failed.itemId,
    { httpStatus: 400 },
    'deterministic-rejection',
  );

  assert.doesNotThrow(
    () => store.enqueue(input({ itemId: 'final-2', text: 'new pending' })),
  );
  assert.equal(store.get(failed.itemId)?.state, 'permanent-failure');
  assert.equal(store.get(failed.itemId)?.failureKind, 'deterministic-rejection');
  assert.equal(store.get(failed.itemId)?.clientId, failed.clientId);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['final-2']);
});

test('active capacity ignores terminal audit records that carry a legacy receipt', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1, maxBytesPerUser: 12 });
  const failed = store.enqueue(input({ itemId: 'failed-with-receipt', text: 'old failure' }));
  store.recordDeliveryReceipt(failed.itemId, 'legacy-reservation', 1);
  store.markPermanentFailure(failed.itemId, { httpStatus: 400 }, 'deterministic-rejection');

  assert.doesNotThrow(
    () => store.enqueue(input({ itemId: 'new-pending', text: 'new pending' })),
  );
  assert.equal(store.get(failed.itemId)?.deliveryReceipt?.reservationId, 'legacy-reservation');
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), ['new-pending']);
});

test('terminal retention expires old failures without deleting pending or receipts', () => {
  let now = 1_000;
  const store = new OutboxStore(tempPath(), {
    now: () => now,
    failedRetentionMs: 100,
    maxFailedItemsPerUser: 10,
    maxFailedBytesPerUser: 1_000,
  });
  const failed = store.enqueue(input({ itemId: 'expired-failure', createdAt: now }));
  store.markPermanentFailure(failed.itemId, { httpStatus: 400 }, 'deterministic-rejection');
  const pending = store.enqueue(input({ itemId: 'pending', createdAt: now, ttlMs: 10_000 }));
  const receipt = store.enqueue(input({ itemId: 'receipt', createdAt: now, ttlMs: 1 }));
  store.recordDeliveryReceipt(receipt.itemId, 'reservation-1', 1);

  now += 101;

  assert.equal(store.get(failed.itemId), undefined);
  assert.equal(store.get(pending.itemId)?.state, 'pending');
  assert.equal(store.get(receipt.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
});

test('terminal retention trims oldest failures to both item and byte budgets', () => {
  let now = 1_000;
  const store = new OutboxStore(tempPath(), {
    now: () => now,
    maxFailedItemsPerUser: 2,
    maxFailedBytesPerUser: 6,
    failedRetentionMs: 10_000,
  });
  for (const [itemId, text] of [
    ['oldest', '1111'],
    ['middle', '22'],
    ['newest', '3333'],
  ] as const) {
    const item = store.enqueue(input({ itemId, text, createdAt: now }));
    store.markPermanentFailure(item.itemId, { httpStatus: 400 }, 'deterministic-rejection');
    now += 1;
  }

  assert.deepEqual(store.list().map((item) => item.itemId), ['middle', 'newest']);
  assert.equal(store.list().reduce((sum, item) => sum + item.bytes, 0), 6);
});

test('items expiring together are immediately constrained by terminal retention', () => {
  const filePath = tempPath();
  let now = 1_000;
  const store = new OutboxStore(filePath, {
    now: () => now,
    maxFailedItemsPerUser: 1,
  });
  store.enqueue(input({ itemId: 'expires-first', createdAt: now, ttlMs: 10 }));
  store.enqueue(input({ itemId: 'expires-second', createdAt: now + 1, ttlMs: 9 }));

  now += 10;

  assert.deepEqual(store.list().map((item) => item.itemId), ['expires-second']);
});

test('capacity pressure never evicts an unreconciled delivery receipt', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 1,
    maxBytesPerUser: 100,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const confirmed = store.enqueue(input({
    itemId: 'confirmed-activity',
    generation: 1,
    priority: 'activity',
  }));
  store.recordDeliveryReceipt(confirmed.itemId, 'reservation-1', 1);

  assert.throws(
    () => store.enqueue(input({ itemId: 'new-final', generation: 2, text: 'new final' })),
    OutboxCapacityError,
  );
  assert.equal(store.get(confirmed.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
});

test('migrates the legacy schema-one item shape without dropping final records', () => {
  const filePath = tempPath();
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    nextSequence: 14,
    items: Array.from({ length: 13 }, (_, index) => ({
      schemaVersion: 1,
      itemId: `legacy-${index + 1}`,
      clientId: `client-${index + 1}`,
      sequence: index + 1,
      kind: 'text',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 9,
      tokenVersion: 9,
      priority: 'final',
      text: `legacy-${index + 1}`,
      bytes: 8,
      createdAt: index + 1,
      expiresAt: Date.now() + 60_000,
      state: 'pending',
    })),
  }));

  const store = new OutboxStore(filePath);
  assert.equal(store.listPending('user-a').length, 13);
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.items.length, 13);
});

test('normalizes an oversized schema-one final batch before delivery planning', () => {
  const filePath = tempPath();
  const fixture = schemaOneLegacyFullChunkFixture();
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');

  assert.equal(pending.length, 13);
  assert.equal(pending.map((item) => item.text).join(''), legacyFullChunkText);
  assert.deepEqual(pending.map((item) => item.itemId),
    Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`));
  assert.deepEqual(pending.map((item) => item.clientId),
    Array.from({ length: 13 }, (_, index) => `legacy-client-${index + 1}`));
  assert.ok(pending.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.deepEqual(pending.map((item) => item.bytes), [
    ...Array.from({ length: 10 }, () => 1_944),
    1_943,
    1_944,
    817,
  ]);
  assert.deepEqual(
    pending.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
    fixture.items.map((item) => ({ createdAt: item.createdAt, expiresAt: item.expiresAt })),
  );
  const plan = planDeliveryWindow(pending as DeliveryItem[], {
    sentItems: 0,
    maxItems: INBOUND_WINDOW_ITEMS,
    maxBytes: 2_000,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  });
  assert.equal(plan.needsContinuation, true);
  const lastSelected = plan.items.at(-1);
  assert.equal(lastSelected?.continuationNoticeAttached, true);
  assert.ok(lastSelected);
  assert.ok(Buffer.byteLength(lastSelected.text, 'utf8') <= 2_000);
  assert.ok(lastSelected.bytes <= 2_000);

  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(backup.schemaVersion, 2);
  assert.equal(persisted.revision, backup.revision);
  assert.deepEqual(persisted, backup);

  const primaryBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), primaryBeforeReload);
  assert.deepEqual(reloaded.listPending('user-a', 'account-a'), pending);
});

test('splits individually oversized pending activity without merging record boundaries', () => {
  const filePath = tempPath();
  const activityText = 'A'.repeat(1_500);
  const intermediateText = 'B'.repeat(1_500);
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    nextSequence: 3,
    items: [
      {
        schemaVersion: 2,
        itemId: 'activity-1',
        clientId: 'activity-client-1',
        sequence: 1,
        kind: 'text',
        accountId: 'account-a',
        userId: 'user-a',
        generation: 1,
        tokenVersion: 1,
        priority: 'activity',
        text: activityText,
        bytes: 1_500,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        state: 'pending',
      },
      {
        schemaVersion: 2,
        itemId: 'intermediate-1',
        clientId: 'intermediate-client-1',
        sequence: 2,
        kind: 'text',
        accountId: 'account-a',
        userId: 'user-a',
        generation: 1,
        tokenVersion: 1,
        priority: 'intermediate',
        text: intermediateText,
        bytes: 1_500,
        createdAt: 2,
        expiresAt: Date.now() + 60_000,
        state: 'pending',
      },
    ],
  }));

  const store = new OutboxStore(filePath, { bodyChunkBytes: 1_000, inboundItemLimit: 10 });
  const pending = store.listPending('user-a', 'account-a');

  assert.equal(pending.length, 4);
  assert.equal(pending.slice(0, 2).map((item) => item.text).join(''), activityText);
  assert.equal(pending.slice(2).map((item) => item.text).join(''), intermediateText);
  assert.equal(pending[0].itemId, 'activity-1');
  assert.equal(pending[2].itemId, 'intermediate-1');
  assert.ok(pending.every((item) => item.bytes <= 1_000));
});

test('normalizes an already-wrapped schema-two failure snapshot once', () => {
  const filePath = tempPath();
  writeFileSync(filePath, JSON.stringify(schemaTwoFailureFixture()));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');
  const oldGeneration = pending.filter((item) => item.generation === 42);

  assert.equal(oldGeneration.length, 13);
  assert.equal(oldGeneration.map((item) => item.text).join(''), legacyFullChunkText);
  assert.ok(oldGeneration.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.equal(pending.at(-1)?.itemId, 'new-confirmation');
  assert.equal(pending.at(-1)?.text, '新会话');
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).revision, 3);

  const primaryBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), primaryBeforeReload);
  assert.deepEqual(reloaded.listPending('user-a', 'account-a'), pending);
});

test('migrates legacy failures conservatively and only once', () => {
  const filePath = tempPath();
  const now = 50_000;
  const base = {
    schemaVersion: 2,
    kind: 'text',
    accountId: 'account-a',
    userId: 'user-a',
    generation: 1,
    tokenVersion: 1,
    priority: 'final',
    bytes: 4,
    createdAt: 1_000,
    expiresAt: 60_000,
  };
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    revision: 7,
    nextSequence: 4,
    items: [
      {
        ...base,
        itemId: 'legacy-terminal',
        clientId: 'legacy-terminal-client',
        sequence: 1,
        text: 'old1',
        state: 'permanent-failure',
      },
      {
        ...base,
        itemId: 'legacy-recovery',
        clientId: 'legacy-recovery-client',
        sequence: 2,
        text: 'old2',
        state: 'pending',
        recoveryRequired: true,
        terminalError: { errmsg: 'unknown delivery outcome' },
      },
      {
        ...base,
        itemId: 'current-terminal',
        clientId: 'current-terminal-client',
        sequence: 3,
        text: 'new3',
        state: 'permanent-failure',
        failureKind: 'deterministic-rejection',
        failedAt: 40_000,
        recoveryAttempts: 2,
      },
    ],
  }));

  const migrated = new OutboxStore(filePath, { now: () => now });
  const legacyTerminal = migrated.get('legacy-terminal');
  assert.equal(legacyTerminal?.failureKind, 'legacy-unknown');
  assert.equal(legacyTerminal?.failedAt, now);
  assert.equal(legacyTerminal?.recoveryAttempts, 0);
  const legacyRecovery = migrated.get('legacy-recovery');
  assert.equal(legacyRecovery?.state, 'permanent-failure');
  assert.equal(legacyRecovery?.failureKind, 'ambiguous-delivery');
  assert.equal(legacyRecovery?.failedAt, now);
  assert.equal(legacyRecovery?.recoveryRequired, undefined);
  assert.deepEqual(legacyRecovery?.terminalError, { errmsg: 'unknown delivery outcome' });
  assert.deepEqual(
    {
      failureKind: migrated.get('current-terminal')?.failureKind,
      failedAt: migrated.get('current-terminal')?.failedAt,
      recoveryAttempts: migrated.get('current-terminal')?.recoveryAttempts,
    },
    { failureKind: 'deterministic-rejection', failedAt: 40_000, recoveryAttempts: 2 },
  );

  const migratedText = readFileSync(filePath, 'utf8');
  assert.equal(JSON.parse(migratedText).revision, 8);
  new OutboxStore(filePath, { now: () => now });
  assert.equal(readFileSync(filePath, 'utf8'), migratedText);
});

test('rejects malformed terminal metadata before migration persistence', async (t) => {
  for (const { name, field, value } of [
    { name: 'unknown failure kind', field: 'failureKind', value: 'network-ish' },
    { name: 'negative failed time', field: 'failedAt', value: -1 },
    { name: 'non-finite failed time', field: 'failedAt', value: Number.POSITIVE_INFINITY },
    { name: 'fractional recovery attempts', field: 'recoveryAttempts', value: 1.5 },
    { name: 'negative recovery attempts', field: 'recoveryAttempts', value: -1 },
  ] as const) {
    await t.test(name, () => {
      const filePath = tempPath();
      const item = {
        ...schemaTwoFailureFixture().items[13],
        state: 'permanent-failure',
        failureKind: 'deterministic-rejection',
        failedAt: 10,
        recoveryAttempts: 0,
        [field]: value,
      };
      const snapshot = {
        schemaVersion: 2,
        revision: 1,
        nextSequence: Number(item.sequence) + 1,
        items: [item],
      };
      const original = JSON.stringify(snapshot, null, 2);
      writeFileSync(filePath, original);

      assertMigrationRejectedWithoutWrite(filePath, original);
    });
  }
});

test('normalizes the incident final run behind same-generation low-priority items', () => {
  const filePath = tempPath();
  const fixture = schemaTwoMixedFailureFixture();
  const expectedFinals = fixture.items.filter((item) => item.generation === 42 && item.priority === 'final');
  const preserved = fixture.items.filter((item) => item.generation !== 42);
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const migratedFinals = store.listPending('user-a', 'account-a')
    .filter((item) => item.generation === 42 && item.priority === 'final');

  assert.equal(migratedFinals.length, 13);
  assert.equal(migratedFinals.map((item) => item.text).join(''), legacyFullChunkText);
  assert.ok(migratedFinals.every((item) => item.bytes <= MIGRATED_BODY_BYTES));
  assert.deepEqual(
    migratedFinals.map((item) => ({ itemId: item.itemId, clientId: item.clientId, sequence: item.sequence })),
    expectedFinals.map((item) => ({
      itemId: item.itemId,
      clientId: item.clientId,
      sequence: item.sequence,
    })),
  );
  for (const expected of preserved) {
    const actual = store.get(String(expected.itemId));
    assert.ok(actual);
    assert.deepEqual(stableMigrationFields(actual), stableMigrationFields(expected));
  }

  const primary = JSON.parse(readFileSync(filePath, 'utf8'));
  const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
  assert.equal(primary.revision, 3);
  assert.equal(backup.revision, primary.revision);
  assert.deepEqual(primary, backup);
  assert.deepEqual(
    primary.items
      .filter((item: OutboxItem) => item.generation === 42 && item.priority === 'final')
      .map((item: OutboxItem) => item.itemId),
    expectedFinals.map((item) => item.itemId),
  );

  const primaryBeforeReload = readFileSync(filePath, 'utf8');
  const reloaded = new OutboxStore(filePath, migrationOptions());
  assert.equal(readFileSync(filePath, 'utf8'), primaryBeforeReload);
  assert.deepEqual(
    reloaded.listPending('user-a', 'account-a')
      .filter((item) => item.generation === 42 && item.priority === 'final'),
    migratedFinals,
  );
});

test('preserves legacy low-priority items when an oversized final run migrates', async (t) => {
  await t.test('retains receiptless, confirmed, and unrelated records', () => {
    const filePath = tempPath();
    const fixture = schemaTwoMixedFailureFixture();
    const confirmed = fixture.items.find((item) => item.itemId === 'legacy-activity-19');
    assert.ok(confirmed);
    confirmed.deliveryReceipt = { reservationId: 'legacy-confirmed', quotaGeneration: 42 };
    const expectedRetainedIds = fixture.items.map((item) => String(item.itemId));
    writeFileSync(filePath, JSON.stringify(fixture));

    const store = new OutboxStore(filePath, migrationOptions());

    for (const itemId of expectedRetainedIds) assert.ok(store.get(itemId));
    const retainedConfirmed = store.get(String(confirmed.itemId));
    assert.ok(retainedConfirmed);
    assert.deepEqual(stableMigrationFields(retainedConfirmed), stableMigrationFields(confirmed));
    assert.deepEqual(retainedConfirmed.deliveryReceipt, confirmed.deliveryReceipt);
    for (const itemId of ['incident-control', 'new-confirmation']) {
      const expected = fixture.items.find((item) => item.itemId === itemId);
      const actual = store.get(itemId);
      assert.ok(expected);
      assert.ok(actual);
      assert.deepEqual(stableMigrationFields(actual), stableMigrationFields(expected));
    }

    const primary = JSON.parse(readFileSync(filePath, 'utf8'));
    const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
    assert.deepEqual(primary, backup);
    assert.deepEqual(primary.items.map((item: OutboxItem) => item.itemId), expectedRetainedIds);
    assert.ok(primary.items.every((item: OutboxItem, index: number, items: OutboxItem[]) =>
      index === 0 || item.sequence > items[index - 1].sequence));
  });

  await t.test('preserves low-priority and frozen final records while splitting safe finals', () => {
    const filePath = tempPath();
    const fixture = schemaTwoMixedFailureFixture();
    const ineligible = fixture.items.find((item) => item.itemId === 'legacy-7');
    assert.ok(ineligible);
    ineligible.state = 'permanent-failure';
    writeFileSync(filePath, JSON.stringify(fixture));

    const store = new OutboxStore(filePath, migrationOptions());

    for (const itemId of ['legacy-intermediate-1', 'legacy-activity-19']) {
      const expected = fixture.items.find((item) => item.itemId === itemId);
      const actual = store.get(itemId);
      assert.ok(expected);
      assert.ok(actual);
      assert.deepEqual(stableMigrationFields(actual), stableMigrationFields(expected));
    }
    const frozen = store.get('legacy-7');
    assert.ok(frozen);
    assert.deepEqual(stableMigrationFields(frozen), stableMigrationFields(ineligible));
    assert.equal(frozen.state, 'permanent-failure');
    assert.ok(store.list().filter((item) => item.priority === 'final' && item.state === 'pending')
      .every((item) => item.bytes <= MIGRATED_BODY_BYTES));
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')),
      JSON.parse(readFileSync(`${filePath}.bak`, 'utf8')),
    );
  });
});

test('rejects malformed schema-two records before migration persistence', async (t) => {
  for (const { name, append } of [
    {
      name: 'missing text',
      append: () => {
        const record = {
          ...schemaTwoFailureFixture().items[13],
          itemId: 'missing-text',
          clientId: 'missing-text-client',
          sequence: 15,
          accountId: 'account-invalid',
          userId: 'user-invalid',
          generation: 50,
        };
        delete record.text;
        return record;
      },
    },
    {
      name: 'missing item id',
      append: () => {
        const record = {
          ...schemaTwoFailureFixture().items[13],
          clientId: 'missing-item-id-client',
          sequence: 15,
          accountId: 'account-invalid',
          userId: 'user-invalid',
          generation: 50,
        };
        delete record.itemId;
        return record;
      },
    },
    {
      name: 'missing client id',
      append: () => {
        const record = {
          ...schemaTwoFailureFixture().items[13],
          itemId: 'missing-client-id',
          sequence: 15,
          accountId: 'account-invalid',
          userId: 'user-invalid',
          generation: 50,
        };
        delete record.clientId;
        return record;
      },
    },
    {
      name: 'non-object entry',
      append: () => null,
    },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      const fixture = schemaTwoFailureFixture();
      fixture.items.push(append() as Record<string, unknown>);
      fixture.nextSequence = 16;
      const original = JSON.stringify(fixture, null, 2);
      writeFileSync(filePath, original);

      assertMigrationRejectedWithoutWrite(filePath, original);
    });
  }
});

test('rejects a duplicate stable item id before migration persistence', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items.push({
    ...fixture.items[13],
    itemId: 'legacy-1',
    clientId: 'duplicate-client',
    sequence: 15,
    accountId: 'account-duplicate',
    userId: 'user-duplicate',
    generation: 50,
    text: 'duplicate record',
    bytes: Buffer.byteLength('duplicate record', 'utf8'),
  });
  fixture.nextSequence = 16;
  const original = JSON.stringify(fixture, null, 2);
  writeFileSync(filePath, original);

  assertMigrationRejectedWithoutWrite(filePath, original);
});

test('rejects malformed schema-two delivery state before migration persistence', async (t) => {
  for (const { name, mutate } of [
    {
      name: 'unknown priority',
      mutate: (item: Record<string, unknown>) => { item.priority = 'unknown-priority'; },
    },
    {
      name: 'unknown state',
      mutate: (item: Record<string, unknown>) => { item.state = 'unknown-state'; },
    },
    {
      name: 'null delivery receipt',
      mutate: (item: Record<string, unknown>) => { item.deliveryReceipt = null; },
    },
    {
      name: 'array delivery receipt',
      mutate: (item: Record<string, unknown>) => { item.deliveryReceipt = []; },
    },
    {
      name: 'missing receipt reservation id',
      mutate: (item: Record<string, unknown>) => {
        item.deliveryReceipt = { quotaGeneration: 42 };
      },
    },
    {
      name: 'empty receipt reservation id',
      mutate: (item: Record<string, unknown>) => {
        item.deliveryReceipt = { reservationId: '', quotaGeneration: 42 };
      },
    },
    {
      name: 'fractional receipt quota generation',
      mutate: (item: Record<string, unknown>) => {
        item.deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: 1.5 };
      },
    },
    {
      name: 'unsafe receipt quota generation',
      mutate: (item: Record<string, unknown>) => {
        item.deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: 1e20 };
      },
    },
    {
      name: 'negative receipt quota generation',
      mutate: (item: Record<string, unknown>) => {
        item.deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: -1 };
      },
    },
    {
      name: 'non-boolean recovery required',
      mutate: (item: Record<string, unknown>) => { item.recoveryRequired = 'true'; },
    },
    {
      name: 'non-boolean continuation notice',
      mutate: (item: Record<string, unknown>) => { item.continuationNoticeAttached = 1; },
    },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      const fixture = schemaTwoFailureFixture();
      mutate(fixture.items[6]);
      const original = JSON.stringify(fixture, null, 2);
      writeFileSync(filePath, original);

      assertMigrationRejectedWithoutWrite(filePath, original);
    });
  }
});

test('preserves explicit false schema-two delivery flags through migration and reload', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items[6].recoveryRequired = false;
  fixture.items[6].continuationNoticeAttached = false;
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const migrated = store.get('legacy-7');
  assert.ok(migrated);
  assert.equal(Object.hasOwn(migrated, 'recoveryRequired'), true);
  assert.equal(migrated.recoveryRequired, false);
  assert.equal(Object.hasOwn(migrated, 'continuationNoticeAttached'), true);
  assert.equal(migrated.continuationNoticeAttached, false);

  const primary = JSON.parse(readFileSync(filePath, 'utf8'));
  const backup = JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'));
  for (const snapshot of [primary, backup]) {
    const item = snapshot.items.find((candidate: OutboxItem) => candidate.itemId === 'legacy-7');
    assert.ok(item);
    assert.equal(Object.hasOwn(item, 'recoveryRequired'), true);
    assert.equal(item.recoveryRequired, false);
    assert.equal(Object.hasOwn(item, 'continuationNoticeAttached'), true);
    assert.equal(item.continuationNoticeAttached, false);
  }

  const reloaded = new OutboxStore(filePath, migrationOptions()).get('legacy-7');
  assert.ok(reloaded);
  assert.equal(Object.hasOwn(reloaded, 'recoveryRequired'), true);
  assert.equal(reloaded.recoveryRequired, false);
  assert.equal(Object.hasOwn(reloaded, 'continuationNoticeAttached'), true);
  assert.equal(reloaded.continuationNoticeAttached, false);
});

test('keeps permissive delivery-state defaults for schema-one snapshots', () => {
  const filePath = tempPath();
  const fixture = schemaOneLegacyFullChunkFixture();
  fixture.items[6].priority = 'unknown-priority';
  fixture.items[6].state = 'unknown-state';
  fixture.items[6].deliveryReceipt = { reservationId: 'legacy-invalid', quotaGeneration: -1 };
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());

  assert.equal(store.get('legacy-7')?.priority, 'final');
  assert.equal(store.get('legacy-7')?.state, 'pending');
  assert.equal(store.get('legacy-7')?.deliveryReceipt, undefined);
  assert.doesNotThrow(() => new OutboxStore(filePath, migrationOptions()));
});

test('rejects empty public enqueue identities before changing snapshots', async (t) => {
  for (const { name, invalidItemId, enqueueInput } of [
    {
      name: 'empty item id',
      invalidItemId: '',
      enqueueInput: input({ itemId: '', clientId: 'new-client', generation: 2 }),
    },
    {
      name: 'empty client id',
      invalidItemId: 'empty-client-id',
      enqueueInput: input({ itemId: 'empty-client-id', clientId: '', generation: 2 }),
    },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      let now = 0;
      const store = new OutboxStore(filePath, { now: () => now });
      store.enqueue(input({
        itemId: 'baseline',
        clientId: 'baseline-client',
        createdAt: now,
        ttlMs: 1,
      }));
      const primaryBefore = readFileSync(filePath, 'utf8');
      const backupBefore = readFileSync(`${filePath}.bak`, 'utf8');

      now = 2;
      assert.throws(() => store.enqueue(enqueueInput), OutboxMigrationError);

      now = 0;
      assert.equal(store.get(invalidItemId), undefined);
      assert.equal(store.get('baseline')?.state, 'pending');
      assert.equal(readFileSync(filePath, 'utf8'), primaryBefore);
      assert.equal(readFileSync(`${filePath}.bak`, 'utf8'), backupBefore);
      const reloaded = new OutboxStore(filePath, { now: () => now });
      assert.equal(reloaded.get('baseline')?.clientId, 'baseline-client');
    });
  }
});

test('rejects invalid public delivery receipts before changing snapshots', async (t) => {
  for (const { name, reservationId, quotaGeneration } of [
    { name: 'empty reservation id', reservationId: '', quotaGeneration: 1 },
    { name: 'fractional quota generation', reservationId: 'reservation-1', quotaGeneration: 1.5 },
    { name: 'negative quota generation', reservationId: 'reservation-1', quotaGeneration: -1 },
    { name: 'unsafe quota generation', reservationId: 'reservation-1', quotaGeneration: 1e20 },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      const store = new OutboxStore(filePath);
      store.enqueue(input({ itemId: 'baseline', clientId: 'baseline-client' }));
      const primaryBefore = readFileSync(filePath, 'utf8');
      const backupBefore = readFileSync(`${filePath}.bak`, 'utf8');

      assert.throws(
        () => store.recordDeliveryReceipt('baseline', reservationId, quotaGeneration),
        OutboxMigrationError,
      );

      assert.equal(store.get('baseline')?.deliveryReceipt, undefined);
      assert.equal(readFileSync(filePath, 'utf8'), primaryBefore);
      assert.equal(readFileSync(`${filePath}.bak`, 'utf8'), backupBefore);
      assert.equal(new OutboxStore(filePath).get('baseline')?.clientId, 'baseline-client');
    });
  }
});

test('public writers always leave snapshots accepted by strict reload', () => {
  const filePath = tempPath();
  const store = new OutboxStore(filePath);
  const item = store.enqueue(input({ itemId: 'writer-item', clientId: 'writer-client' }));
  assert.doesNotThrow(() => new OutboxStore(filePath));

  assert.equal(store.recordDeliveryReceipt(item.itemId, 'reservation-1', 0), true);
  assert.doesNotThrow(() => new OutboxStore(filePath));

  assert.equal(store.markPermanentFailure(item.itemId, { errmsg: 'terminal' }), true);
  assert.doesNotThrow(() => new OutboxStore(filePath));
  assertSafePersistedSequences(filePath);
});

test('rejects incomplete or invalid migration configuration', () => {
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: 0, inboundItemLimit: 10 }),
    OutboxMigrationError,
  );
  assert.throws(
    () => new OutboxStore(tempPath(), { bodyChunkBytes: MIGRATED_BODY_BYTES }),
    OutboxMigrationError,
  );
});

test('does not publish an unrepresentable UTF-8 rechunk migration', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items = fixture.items.slice(0, 11);
  fixture.nextSequence = 12;
  fixture.items[0].text = '汉';
  fixture.items[0].bytes = Buffer.byteLength('汉', 'utf8');
  for (let index = 1; index < fixture.items.length; index += 1) {
    fixture.items[index].text = String.fromCharCode(65 + index);
    fixture.items[index].bytes = 1;
  }
  const before = JSON.stringify(fixture, null, 2);
  writeFileSync(filePath, before);

  assert.throws(
    () => new OutboxStore(filePath, { bodyChunkBytes: 1, inboundItemLimit: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /UTF-8 rechunk invariant failed|normalization could not preserve text/i);
      return true;
    },
  );
  assert.equal(readFileSync(filePath, 'utf8'), before);
  assert.equal(existsSync(`${filePath}.bak`), false);
});

test('enforces the byte ceiling per safe record while preserving frozen records', async (t) => {
  for (const { name, pretty, mutate } of [
  {
    name: 'all compliant bodies',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items.slice(0, 13).forEach((item, index) => {
        const text = String.fromCharCode(65 + index).repeat(MIGRATED_BODY_BYTES);
        item.text = text;
        item.bytes = Buffer.byteLength(text, 'utf8');
      });
    },
  },
  {
    name: 'multiple inbound-sized generations',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items.slice(6, 13).forEach((item) => { item.generation = 43; });
    },
  },
  {
    name: 'an intermediate-priority member',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].priority = 'intermediate';
    },
  },
  {
    name: 'a permanent-failure member',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].state = 'permanent-failure';
    },
  },
  {
    name: 'a member with a delivery receipt',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].deliveryReceipt = { reservationId: 'reservation-1', quotaGeneration: 42 };
    },
  },
  {
    name: 'a recovery-required member',
    pretty: false,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].recoveryRequired = true;
    },
  },
  {
    name: 'a continuation-notice member',
    pretty: true,
    mutate: (fixture: ReturnType<typeof schemaTwoFailureFixture>) => {
      fixture.items[6].continuationNoticeAttached = true;
    },
  },
  ]) {
    await t.test(name, () => {
      const filePath = tempPath();
      const fixture = schemaTwoFailureFixture();
      mutate(fixture);
      const before = pretty ? JSON.stringify(fixture, null, 2) : JSON.stringify(fixture);
      writeFileSync(filePath, before);

      const store = new OutboxStore(filePath, migrationOptions());
      const loaded = store.list();
      const expectsWrite = fixture.items.some((item) => item.recoveryRequired === true
        || (item.state === 'pending'
        && !item.deliveryReceipt
        && !item.recoveryRequired
        && !item.continuationNoticeAttached
        && Buffer.byteLength(String(item.text), 'utf8') > MIGRATED_BODY_BYTES));

      fixture.items.forEach((item, index) => {
        const start = loaded.findIndex((candidate) => candidate.itemId === item.itemId);
        const nextOriginalId = fixture.items[index + 1]?.itemId;
        const end = nextOriginalId === undefined
          ? loaded.length
          : loaded.findIndex((candidate) => candidate.itemId === nextOriginalId);
        assert.ok(start >= 0);
        assert.ok(end > start);
        const records = loaded.slice(start, end);
        assert.equal(records.map((record) => record.text).join(''), item.text);

        const frozen = item.state !== 'pending'
          || Boolean(item.deliveryReceipt)
          || Boolean(item.recoveryRequired)
          || Boolean(item.continuationNoticeAttached);
        const oversized = Buffer.byteLength(String(item.text), 'utf8') > MIGRATED_BODY_BYTES;
        if (!frozen && oversized) {
          assert.ok(records.length > 1);
          assert.ok(records.every((record) => record.bytes <= MIGRATED_BODY_BYTES));
          assert.equal(records[0].itemId, item.itemId);
          assert.equal(records[0].clientId, item.clientId);
        } else {
          assert.equal(records.length, 1);
          if (item.recoveryRequired === true) {
            assert.deepEqual(stableMigrationFields(records[0]), {
              ...stableMigrationFields(item),
              state: 'permanent-failure',
            });
            assert.equal(records[0].failureKind, 'ambiguous-delivery');
            assert.equal(records[0].recoveryRequired, undefined);
          } else {
            assert.deepEqual(stableMigrationFields(records[0]), stableMigrationFields(item));
            assert.equal(records[0].recoveryRequired, item.recoveryRequired);
          }
          assert.deepEqual(records[0].deliveryReceipt, item.deliveryReceipt);
          assert.equal(records[0].continuationNoticeAttached, item.continuationNoticeAttached);
        }
      });

      if (expectsWrite) {
        assert.deepEqual(
          JSON.parse(readFileSync(filePath, 'utf8')),
          JSON.parse(readFileSync(`${filePath}.bak`, 'utf8')),
        );
      } else {
        assert.equal(readFileSync(filePath, 'utf8'), before);
        assert.equal(existsSync(`${filePath}.bak`), false);
      }
    });
  }
});

test('preserves positional item identities while expanding and contracting a migration batch', async (t) => {
  await t.test('expansion retains existing identities and persists the appended identity', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items = fixture.items.slice(0, 11);
    fixture.nextSequence = 12;
    const originalIds = fixture.items.map((item) => String(item.itemId));
    assert.equal(
      fixture.items.reduce((total, item) => total + Number(item.bytes), 0),
      22_000,
    );
    writeFileSync(filePath, JSON.stringify(fixture));

    const migrated = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.equal(migrated.length, 12);
    assert.deepEqual(migrated.slice(0, 11).map((item) => item.itemId), originalIds);
    const appendedId = migrated[11].itemId;
    assert.equal(originalIds.includes(appendedId), false);

    const reloaded = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.equal(reloaded[11].itemId, appendedId);
  });

  await t.test('contraction retains only used identities and preserves the following batch', () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items = [...fixture.items.slice(0, 11), fixture.items[13]];
    fixture.items[0].text = 'A'.repeat(2_000);
    fixture.items[0].bytes = 2_000;
    for (let index = 1; index < 11; index += 1) {
      const text = String(index);
      fixture.items[index].text = text;
      fixture.items[index].bytes = Buffer.byteLength(text, 'utf8');
    }
    const originalText = fixture.items.slice(0, 11).map((item) => String(item.text)).join('');
    writeFileSync(filePath, JSON.stringify(fixture));

    const migrated = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.deepEqual(migrated.map((item) => item.itemId), [
      'legacy-1',
      'legacy-2',
      'new-confirmation',
    ]);
    assert.equal(migrated.slice(0, 2).map((item) => item.text).join(''), originalText);
    assertSafePersistedSequences(filePath);

    const reloaded = new OutboxStore(filePath, migrationOptions())
      .listPending('user-a', 'account-a');
    assert.deepEqual(reloaded.map((item) => item.itemId), [
      'legacy-1',
      'legacy-2',
      'new-confirmation',
    ]);
    assert.equal(reloaded.slice(0, 2).map((item) => item.text).join(''), originalText);
    assert.equal(reloaded.at(-1)?.text, '新会话');
    assert.equal(reloaded.at(-1)?.state, 'pending');
  });
});

test('sanitizes unsafe migration sequences without losing snapshot FIFO order', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.nextSequence = 1e20;
  fixture.items.forEach((item) => { item.sequence = 1e20; });
  writeFileSync(filePath, JSON.stringify(fixture));

  const store = new OutboxStore(filePath, migrationOptions());
  const pending = store.listPending('user-a', 'account-a');

  assert.deepEqual(pending.map((item) => item.itemId), [
    ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
    'new-confirmation',
  ]);
  assert.equal(
    pending.filter((item) => item.generation === 42).map((item) => item.text).join(''),
    legacyFullChunkText,
  );
  assertSafePersistedSequences(filePath);
});

for (const { name, sequenceFor } of [
  { name: 'duplicate', sequenceFor: () => 100 },
  { name: 'non-monotonic', sequenceFor: (index: number) => 100 - index },
]) {
  test(`canonicalizes ${name} safe sequences without losing snapshot FIFO order`, () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.items.forEach((item, index) => { item.sequence = sequenceFor(index); });
    fixture.nextSequence = 1_000;
    writeFileSync(filePath, JSON.stringify(fixture));

    const store = new OutboxStore(filePath, migrationOptions());
    const pending = store.listPending('user-a', 'account-a');

    assert.deepEqual(pending.map((item) => item.itemId), [
      ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
      'new-confirmation',
    ]);
    assert.equal(
      pending.filter((item) => item.generation === 42).map((item) => item.text).join(''),
      legacyFullChunkText,
    );
    assertSafePersistedSequences(filePath);
  });
}

for (const { name, value } of [
  { name: 'fractional', value: 1.5 },
  { name: 'negative', value: -1 },
]) {
  test(`sanitizes ${name} migration sequences in deterministic snapshot order`, () => {
    const filePath = tempPath();
    const fixture = schemaTwoFailureFixture();
    fixture.nextSequence = value;
    fixture.items.forEach((item) => { item.sequence = value; });
    writeFileSync(filePath, JSON.stringify(fixture));

    const store = new OutboxStore(filePath, migrationOptions());
    const pending = store.listPending('user-a', 'account-a');

    assert.deepEqual(pending.map((item) => item.itemId), [
      ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
      'new-confirmation',
    ]);
    assert.equal(
      pending.filter((item) => item.generation === 42).map((item) => item.text).join(''),
      legacyFullChunkText,
    );
    assertSafePersistedSequences(filePath);
  });
}

test('rejects migration when no safe next sequence remains', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  const firstSequence = Number.MAX_SAFE_INTEGER - fixture.items.length;
  fixture.items.forEach((item, index) => { item.sequence = firstSequence + index; });
  fixture.nextSequence = Number.MAX_SAFE_INTEGER;
  fixture.items[12].text = `${fixture.items[12].text}${'Z'.repeat(MIGRATED_BODY_BYTES)}`;
  const encoded = JSON.stringify(fixture);
  writeFileSync(filePath, encoded);

  assert.throws(
    () => new OutboxStore(filePath, migrationOptions()),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /^outbox migration failed: .*sequence/i);
      return true;
    },
  );
  assert.equal(readFileSync(filePath, 'utf8'), encoded);
});

test('rejects enqueue when no safe successor sequence remains without changing snapshots', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.nextSequence = Number.MAX_SAFE_INTEGER;
  writeFileSync(filePath, JSON.stringify(fixture));
  const store = new OutboxStore(filePath, migrationOptions());
  const primaryBefore = readFileSync(filePath, 'utf8');
  const backupBefore = readFileSync(`${filePath}.bak`, 'utf8');

  assert.throws(
    () => store.enqueue(input({ itemId: 'sequence-capacity', generation: 50 })),
    (error: unknown) => {
      assert.ok(error instanceof OutboxMigrationError);
      assert.match(error.message, /sequence capacity/i);
      return true;
    },
  );
  assert.equal(store.get('sequence-capacity'), undefined);
  assert.equal(readFileSync(filePath, 'utf8'), primaryBefore);
  assert.equal(readFileSync(`${filePath}.bak`, 'utf8'), backupBefore);
  assert.doesNotThrow(() => new OutboxStore(filePath, migrationOptions()));
});

test('a public update persists only canonical sequence invariants', () => {
  const filePath = tempPath();
  const fixture = schemaTwoFailureFixture();
  fixture.items = fixture.items.slice(0, 2);
  fixture.items[0].sequence = 2;
  fixture.items[1].sequence = 1;
  fixture.nextSequence = 1;
  writeFileSync(filePath, JSON.stringify(fixture));
  const store = new OutboxStore(filePath, migrationOptions());

  assert.ok(store.freezeText('legacy-1', 'updated text'));

  assertSafePersistedSequences(filePath);
});

test('recovers the primary file from a valid backup snapshot', () => {
  const filePath = tempPath();
  const store = new OutboxStore(filePath);
  store.enqueue(input({ itemId: 'recover-1' }));
  writeFileSync(filePath, '{ not valid json');

  const recovered = new OutboxStore(filePath);
  assert.equal(recovered.listPending('user-a')[0]?.itemId, 'recover-1');
});

test('prefers a newer valid backup after a crash before the primary write', () => {
  const filePath = tempPath();
  const backupPath = `${filePath}.bak`;
  const baseItem = {
    ...input({ itemId: 'newer-backup' }),
    schemaVersion: 2,
    clientId: 'stable-client',
    sequence: 1,
    kind: 'text',
    bytes: 11,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    state: 'pending',
  };
  writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, revision: 1, nextSequence: 1, items: [] }));
  writeFileSync(backupPath, JSON.stringify({ schemaVersion: 2, revision: 2, nextSequence: 2, items: [baseItem] }));

  const recovered = new OutboxStore(filePath);

  assert.equal(recovered.listPending('user-a')[0]?.itemId, 'newer-backup');
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).items[0]?.itemId, 'newer-backup');
});

test('batch enqueue is atomic when a later final item exceeds capacity', () => {
  const store = new OutboxStore(tempPath(), { maxItemsPerUser: 1 });
  const existing = store.enqueueText(input({ itemId: 'existing' }));

  assert.throws(() => store.enqueueTextBatch([
    input({ itemId: 'new-1', text: 'new first' }),
    input({ itemId: 'new-2', text: 'new second' }),
  ]), OutboxCapacityError);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [existing.itemId]);
});

test('capacity pressure never evicts queued activity for a final result', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 2,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  store.enqueue(input({ itemId: 'activity-1', priority: 'activity', text: 'activity' }));
  store.enqueue(input({ itemId: 'activity-2', priority: 'activity', text: 'activity 2' }));

  assert.throws(() => store.enqueue(input({ itemId: 'final-1', text: 'final' })), OutboxCapacityError);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [
    'activity-1',
    'activity-2',
  ]);
});

test('recovers only recent expired failures whose attempt backoff elapsed', () => {
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const now = 20 * day;
  const filePath = tempPath();
  const specs = [
    ['eligible-first', 'expired-before-delivery', now, 0],
    ['eligible-second', 'expired-before-delivery', now - 5 * minute, 1],
    ['eligible-third', 'expired-before-delivery', now - 30 * minute, 2],
    ['backoff-first', 'expired-before-delivery', now - 5 * minute + 1, 1],
    ['backoff-second', 'expired-before-delivery', now - 30 * minute + 1, 2],
    ['attempts-exhausted', 'expired-before-delivery', now - day, 3],
    ['too-old', 'expired-before-delivery', now - 14 * day - 1, 0],
    ['deterministic', 'deterministic-rejection', now - day, 0],
    ['ambiguous', 'ambiguous-delivery', now - day, 0],
    ['legacy', 'legacy-unknown', now - day, 0],
  ] as const;
  const items = specs.map(([itemId, failureKind, failedAt, recoveryAttempts], index) => ({
    schemaVersion: 2,
    itemId,
    clientId: `${itemId}-client`,
    sequence: index + 1,
    kind: 'text',
    accountId: 'account-a',
    userId: 'user-a',
    generation: 1,
    tokenVersion: 1,
    priority: 'final',
    text: `${itemId}-body`,
    bytes: Buffer.byteLength(`${itemId}-body`, 'utf8'),
    createdAt: 1,
    expiresAt: 2,
    state: 'permanent-failure',
    terminalError: { errmsg: `${itemId}-error` },
    failureKind,
    failedAt,
    recoveryAttempts,
  }));
  items.push({
    ...items[0],
    itemId: 'receipt-failure',
    clientId: 'receipt-failure-client',
    sequence: items.length + 1,
    deliveryReceipt: { reservationId: 'reservation-1', quotaGeneration: 1 },
  } as typeof items[number]);
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    nextSequence: items.length + 1,
    items,
  }));
  const store = new OutboxStore(filePath, { now: () => now, failedRetentionMs: 30 * day });

  const recovered = store.recoverExpiredFailures('account-a', 'user-a');

  assert.deepEqual(recovered, [
    { itemId: 'eligible-first', kind: 'expired-before-delivery', ageMs: 0, attempt: 1 },
    { itemId: 'eligible-second', kind: 'expired-before-delivery', ageMs: 5 * minute, attempt: 2 },
    { itemId: 'eligible-third', kind: 'expired-before-delivery', ageMs: 30 * minute, attempt: 3 },
  ]);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [
    'eligible-first',
    'eligible-second',
    'eligible-third',
  ]);
  assert.deepEqual(store.list().filter((item) => item.state === 'permanent-failure')
    .map((item) => item.itemId), [
    'backoff-first',
    'backoff-second',
    'attempts-exhausted',
    'too-old',
    'deterministic',
    'ambiguous',
    'legacy',
    'receipt-failure',
  ]);
});

test('recovered failures append to the active FIFO tail in stable relative order', () => {
  let now = 1_000;
  const filePath = tempPath();
  const store = new OutboxStore(filePath, { now: () => now, defaultTtlMs: 100 });
  const activeFirst = store.enqueue(input({ itemId: 'active-first', text: 'active one', ttlMs: 10_000 }));
  const expiredFirst = store.enqueue(input({ itemId: 'expired-first', text: 'expired one', ttlMs: 1 }));
  const expiredSecond = store.enqueue(input({ itemId: 'expired-second', text: 'expired two', ttlMs: 1 }));
  const activeLast = store.enqueue(input({ itemId: 'active-last', text: 'active two', ttlMs: 10_000 }));
  now += 1;
  assert.equal(store.get(expiredFirst.itemId)?.state, 'permanent-failure');
  assert.equal(store.get(expiredSecond.itemId)?.state, 'permanent-failure');

  const recovered = store.recoverExpiredFailures('account-a', 'user-a');

  assert.deepEqual(recovered.map((item) => item.itemId), ['expired-first', 'expired-second']);
  assert.deepEqual(store.listPending('user-a').map((item) => item.itemId), [
    activeFirst.itemId,
    activeLast.itemId,
    expiredFirst.itemId,
    expiredSecond.itemId,
  ]);
  for (const original of [expiredFirst, expiredSecond]) {
    const item = store.get(original.itemId);
    assert.equal(item?.clientId, original.clientId);
    assert.equal(item?.text, original.text);
    assert.equal(item?.recoveryAttempts, 1);
    assert.equal(item?.expiresAt, now + 100);
  }

  const reloaded = new OutboxStore(filePath, { now: () => now, defaultTtlMs: 100 });
  assert.deepEqual(reloaded.listPending('user-a').map((item) => item.itemId), [
    activeFirst.itemId,
    activeLast.itemId,
    expiredFirst.itemId,
    expiredSecond.itemId,
  ]);
  assert.deepEqual(
    reloaded.listPending('user-a').slice(-2).map((item) => item.recoveryAttempts),
    [1, 1],
  );
});

test('restart preserves recovery attempts and enforces the next backoff', () => {
  let now = 1_000;
  const filePath = tempPath();
  const first = new OutboxStore(filePath, { now: () => now, defaultTtlMs: 100 });
  first.enqueue(input({ itemId: 'retry-after-restart', ttlMs: 1 }));
  now += 1;
  assert.equal(first.recoverExpiredFailures('account-a', 'user-a')[0]?.attempt, 1);

  now += 100;
  const restarted = new OutboxStore(filePath, { now: () => now, defaultTtlMs: 100 });
  assert.equal(restarted.get('retry-after-restart')?.state, 'permanent-failure');
  assert.equal(restarted.get('retry-after-restart')?.recoveryAttempts, 1);
  assert.deepEqual(restarted.recoverExpiredFailures('account-a', 'user-a'), []);

  now += 5 * 60_000;
  assert.equal(restarted.recoverExpiredFailures('account-a', 'user-a')[0]?.attempt, 2);
});

test('an unreconciled delivery receipt does not expire before acknowledgement', () => {
  let now = 1_000;
  const store = new OutboxStore(tempPath(), { defaultTtlMs: 100, now: () => now });
  const item = store.enqueue(input({ itemId: 'confirmed-before-expiry' }));
  store.recordDeliveryReceipt(item.itemId, 'reservation-1', 1);

  now = 1_100;

  assert.equal(store.get(item.itemId)?.state, 'pending');
  assert.equal(store.get(item.itemId)?.deliveryReceipt?.reservationId, 'reservation-1');
});
