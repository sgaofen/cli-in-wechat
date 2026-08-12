import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';
import { chunkUtf8Text } from './text-chunk.js';

export type OutboxPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';
export type OutboxState = 'pending' | 'permanent-failure';
export type OutboxFailureKind =
  | 'expired-before-delivery'
  | 'deterministic-rejection'
  | 'ambiguous-delivery'
  | 'legacy-unknown';

export interface OutboxError {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  httpStatus?: number;
}

export interface OutboxItem {
  schemaVersion: 2;
  itemId: string;
  clientId: string;
  sequence: number;
  kind: 'text';
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  text: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  state: OutboxState;
  deliveryReceipt?: {
    reservationId: string;
    quotaGeneration: number;
  };
  continuationNoticeAttached?: boolean;
  recoveryRequired?: boolean;
  terminalError?: OutboxError;
  failureKind?: OutboxFailureKind;
  failedAt?: number;
  recoveryAttempts?: number;
}

export interface OutboxInput {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  text: string;
  itemId?: string;
  clientId?: string;
  createdAt?: number;
  ttlMs?: number;
}

export interface OutboxOptions {
  defaultTtlMs?: number;
  maxItemsPerUser?: number;
  maxBytesPerUser?: number;
  maxFailedItemsPerUser?: number;
  maxFailedBytesPerUser?: number;
  failedRetentionMs?: number;
  finalReserveItems?: number;
  finalReserveBytes?: number;
  bodyChunkBytes?: number;
  inboundItemLimit?: number;
  now?: () => number;
}

export interface OutboxRecovery {
  itemId: string;
  kind: 'expired-before-delivery';
  ageMs: number;
  attempt: number;
}

export class OutboxCapacityError extends Error {
  constructor(message = 'outbox capacity exceeded; durable final content was preserved') {
    super(message);
    this.name = 'OutboxCapacityError';
  }
}

export class OutboxCorruptionError extends Error {
  constructor(public readonly filePath: string) {
    super(`outbox is corrupt and has no recoverable snapshot: ${filePath}`);
    this.name = 'OutboxCorruptionError';
  }
}

export class OutboxMigrationError extends Error {
  constructor(message: string) {
    super(`outbox migration failed: ${message}`);
    this.name = 'OutboxMigrationError';
  }
}

interface PersistedOutbox {
  schemaVersion: 2;
  revision: number;
  nextSequence: number;
  items: OutboxItem[];
}

interface LegacySnapshot {
  schemaVersion?: number;
  revision?: number;
  nextSequence?: number;
  items?: unknown[];
}

interface LoadedOutboxState {
  revision: number;
  nextSequence: number;
  items: Map<string, OutboxItem>;
  changed: boolean;
}

interface NormalizedOutboxState {
  nextSequence: number;
  items: Map<string, OutboxItem>;
  changed: boolean;
}

interface DecodedSnapshotCandidate {
  snapshot: LegacySnapshot;
  loaded: LoadedOutboxState;
  normalized: NormalizedOutboxState;
}

interface DecodedDeliveryState {
  priority: OutboxPriority;
  state: OutboxState;
  deliveryReceipt?: OutboxItem['deliveryReceipt'];
  continuationNoticeAttached?: boolean;
  recoveryRequired?: boolean;
  failureKind?: OutboxFailureKind;
  failedAt?: number;
  recoveryAttempts?: number;
  changed: boolean;
}

const OUTBOX_PRIORITIES = new Set<OutboxPriority>([
  'final',
  'control',
  'media',
  'intermediate',
  'activity',
]);

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FAILED_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_MAX_FAILED_ITEMS_PER_USER = 100;
const DEFAULT_MAX_FAILED_BYTES_PER_USER = 200_000;
const MAX_RECOVERY_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = [0, 5 * 60_000, 30 * 60_000] as const;

export class OutboxStore {
  private readonly items = new Map<string, OutboxItem>();
  private readonly backupPath: string;
  private readonly defaultTtlMs: number;
  private readonly maxItemsPerUser: number;
  private readonly maxBytesPerUser: number;
  private readonly maxFailedItemsPerUser: number;
  private readonly maxFailedBytesPerUser: number;
  private readonly failedRetentionMs: number;
  private readonly bodyChunkBytes?: number;
  private readonly inboundItemLimit?: number;
  private readonly now: () => number;
  private nextSequence = 1;
  private revision = 0;

  constructor(private readonly filePath: string, options: OutboxOptions = {}) {
    this.backupPath = `${filePath}.bak`;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.maxBytesPerUser = options.maxBytesPerUser ?? 1_000_000;
    this.maxFailedItemsPerUser = nonNegativeSafeIntegerOption(
      'maxFailedItemsPerUser',
      options.maxFailedItemsPerUser,
      DEFAULT_MAX_FAILED_ITEMS_PER_USER,
    );
    this.maxFailedBytesPerUser = nonNegativeSafeIntegerOption(
      'maxFailedBytesPerUser',
      options.maxFailedBytesPerUser,
      DEFAULT_MAX_FAILED_BYTES_PER_USER,
    );
    this.failedRetentionMs = nonNegativeSafeIntegerOption(
      'failedRetentionMs',
      options.failedRetentionMs,
      DEFAULT_FAILED_RETENTION_MS,
    );
    if (options.bodyChunkBytes === undefined && options.inboundItemLimit === undefined) {
      this.bodyChunkBytes = undefined;
      this.inboundItemLimit = undefined;
    } else {
      if (!Number.isInteger(options.bodyChunkBytes) || options.bodyChunkBytes! <= 0) {
        throw new OutboxMigrationError('invalid bodyChunkBytes: expected a positive integer');
      }
      if (!Number.isInteger(options.inboundItemLimit) || options.inboundItemLimit! <= 0) {
        throw new OutboxMigrationError('invalid inboundItemLimit: expected a positive integer');
      }
      this.bodyChunkBytes = options.bodyChunkBytes;
      this.inboundItemLimit = options.inboundItemLimit;
    }
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
    this.pruneExpired();
  }

  enqueue(input: OutboxInput): OutboxItem {
    return this.enqueueTextBatch([input])[0];
  }

  enqueueText(input: OutboxInput): OutboxItem {
    return this.enqueue(input);
  }

  enqueueTextBatch(inputs: OutboxInput[]): OutboxItem[] {
    if (inputs.length === 0) return [];
    const nextItems = new Map(this.items);
    let changed = this.expireAndPrune(nextItems);
    let nextSequence = this.nextSequence;
    const result: OutboxItem[] = [];

    for (const input of inputs) {
      if (input.itemId) {
        const existing = nextItems.get(input.itemId);
        if (existing) {
          result.push(existing);
          continue;
        }
      }
      const bytes = Buffer.byteLength(input.text, 'utf8');
      const userItems = [...nextItems.values()].filter((item) =>
        item.accountId === input.accountId
        && item.userId === input.userId
        && item.state === 'pending');
      this.ensureCapacity(userItems, bytes);
      const createdAt = input.createdAt ?? this.now();
      const sequence = asPositiveSafeInteger(nextSequence);
      if (sequence === undefined) throw sequenceCapacityError();
      const followingSequence = nextSafeSequence(sequence);
      const item: OutboxItem = {
        schemaVersion: 2,
        itemId: input.itemId ?? randomUUID(),
        clientId: input.clientId ?? randomUUID(),
        sequence,
        kind: 'text',
        accountId: input.accountId,
        userId: input.userId,
        generation: input.generation,
        tokenVersion: input.tokenVersion,
        priority: input.priority,
        text: input.text,
        bytes,
        createdAt,
        expiresAt: createdAt + (input.ttlMs ?? this.defaultTtlMs),
        state: 'pending',
      };
      nextItems.set(item.itemId, item);
      nextSequence = followingSequence;
      result.push(item);
      changed = true;
    }

    if (changed) {
      this.persistState(nextItems, nextSequence);
      this.publish(nextItems, nextSequence);
    }
    return result;
  }

  list(userId?: string, accountId?: string): OutboxItem[] {
    this.pruneExpired();
    return [...this.items.values()]
      .filter((item) => (userId === undefined || item.userId === userId)
        && (accountId === undefined || item.accountId === accountId))
      .sort((a, b) => a.sequence - b.sequence
        || a.itemId.localeCompare(b.itemId));
  }

  listPending(userId?: string, accountId?: string): OutboxItem[] {
    return this.list(userId, accountId).filter((item) => item.state === 'pending');
  }

  get(itemId: string): OutboxItem | undefined {
    this.pruneExpired();
    return this.items.get(itemId);
  }

  ack(itemId: string): boolean {
    if (!this.items.has(itemId)) return false;
    const nextItems = new Map(this.items);
    nextItems.delete(itemId);
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  recordDeliveryReceipt(itemId: string, reservationId: string, quotaGeneration: number): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state !== 'pending') return false;
    if (item.deliveryReceipt) {
      return item.deliveryReceipt.reservationId === reservationId
        && item.deliveryReceipt.quotaGeneration === quotaGeneration;
    }
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, deliveryReceipt: { reservationId, quotaGeneration } });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  markAmbiguous(itemId: string, error: OutboxError): boolean {
    return this.markPermanentFailure(itemId, error, 'ambiguous-delivery');
  }

  freezeText(itemId: string, text: string, continuationNoticeAttached = false): OutboxItem | undefined {
    const item = this.items.get(itemId);
    if (!item || item.state !== 'pending') return undefined;
    if (item.text === text && Boolean(item.continuationNoticeAttached) === continuationNoticeAttached) return item;
    const nextItems = new Map(this.items);
    const frozen = {
      ...item,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      continuationNoticeAttached,
    };
    nextItems.set(itemId, frozen);
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return frozen;
  }

  markPermanentFailure(
    itemId: string,
    error: OutboxError,
    failureKind: OutboxFailureKind = 'legacy-unknown',
  ): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state === 'permanent-failure') return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, {
      ...item,
      state: 'permanent-failure',
      recoveryRequired: false,
      terminalError: error,
      failureKind,
      failedAt: this.now(),
      recoveryAttempts: item.recoveryAttempts ?? 0,
    });
    this.pruneFailed(nextItems);
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  private ensureCapacity(userItems: OutboxItem[], incomingBytes: number): void {
    const count = userItems.length + 1;
    const bytes = userItems.reduce((sum, item) => sum + item.bytes, 0) + incomingBytes;
    if (count > this.maxItemsPerUser || bytes > this.maxBytesPerUser) {
      throw new OutboxCapacityError();
    }
  }

  private pruneExpired(): void {
    const nextItems = new Map(this.items);
    if (!this.expireAndPrune(nextItems)) return;
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
  }

  private expireAndPrune(target: Map<string, OutboxItem>): boolean {
    const expired = this.markExpired(target);
    const pruned = this.pruneFailed(target);
    return expired || pruned;
  }

  private markExpired(target: Map<string, OutboxItem>): boolean {
    let changed = false;
    for (const [itemId, item] of target) {
      if (item.state === 'pending' && !item.deliveryReceipt && item.expiresAt <= this.now()) {
        target.set(itemId, {
          ...item,
          state: 'permanent-failure',
          terminalError: { errmsg: 'outbox item expired before delivery' },
          failureKind: 'expired-before-delivery',
          failedAt: item.expiresAt,
          recoveryAttempts: item.recoveryAttempts ?? 0,
        });
        changed = true;
      }
    }
    return changed;
  }

  recoverExpiredFailures(accountId: string, userId: string): OutboxRecovery[] {
    const nextItems = new Map(this.items);
    const expiredOrPruned = this.expireAndPrune(nextItems);
    const now = this.now();
    const eligible = [...nextItems.values()]
      .filter((item) => item.accountId === accountId
        && item.userId === userId
        && item.state === 'permanent-failure'
        && !item.deliveryReceipt
        && item.failureKind === 'expired-before-delivery'
        && (item.recoveryAttempts ?? 0) < MAX_RECOVERY_ATTEMPTS
        && item.failedAt !== undefined
        && now - item.failedAt >= 0
        && now - item.failedAt <= MAX_RECOVERY_AGE_MS
        && now - item.failedAt >= RECOVERY_BACKOFF_MS[item.recoveryAttempts ?? 0])
      .sort((left, right) => left.sequence - right.sequence
        || left.itemId.localeCompare(right.itemId));

    let activeCount = 0;
    let activeBytes = 0;
    for (const item of nextItems.values()) {
      if (item.accountId !== accountId || item.userId !== userId || item.state !== 'pending') continue;
      activeCount += 1;
      activeBytes += item.bytes;
    }

    let nextSequence = this.nextSequence;
    const recovered: OutboxRecovery[] = [];
    for (const item of eligible) {
      if (activeCount + 1 > this.maxItemsPerUser
        || activeBytes + item.bytes > this.maxBytesPerUser) break;
      const sequence = asPositiveSafeInteger(nextSequence);
      if (sequence === undefined) throw sequenceCapacityError();
      nextSequence = nextSafeSequence(sequence);
      const attempt = (item.recoveryAttempts ?? 0) + 1;
      const ageMs = now - item.failedAt!;
      const requeued: OutboxItem = {
        ...item,
        sequence,
        state: 'pending',
        expiresAt: now + this.defaultTtlMs,
        recoveryAttempts: attempt,
      };
      delete requeued.recoveryRequired;
      delete requeued.terminalError;
      delete requeued.failureKind;
      delete requeued.failedAt;
      nextItems.delete(item.itemId);
      nextItems.set(item.itemId, requeued);
      activeCount += 1;
      activeBytes += item.bytes;
      recovered.push({ itemId: item.itemId, kind: 'expired-before-delivery', ageMs, attempt });
    }

    if (expiredOrPruned || recovered.length > 0) {
      this.persistState(nextItems, nextSequence);
      this.publish(nextItems, nextSequence);
    }
    return recovered;
  }

  private pruneFailed(target: Map<string, OutboxItem>): boolean {
    const failedByUser = new Map<string, OutboxItem[]>();
    for (const item of target.values()) {
      if (item.state !== 'permanent-failure') continue;
      const key = `${item.accountId}\u0000${item.userId}`;
      const failures = failedByUser.get(key) ?? [];
      failures.push(item);
      failedByUser.set(key, failures);
    }

    let changed = false;
    for (const failures of failedByUser.values()) {
      failures.sort((left, right) => (left.failedAt ?? left.createdAt) - (right.failedAt ?? right.createdAt)
        || left.sequence - right.sequence
        || left.itemId.localeCompare(right.itemId));
      const retained: OutboxItem[] = [];
      for (const item of failures) {
        const failedAt = item.failedAt ?? item.createdAt;
        if (this.now() - failedAt > this.failedRetentionMs) {
          target.delete(item.itemId);
          changed = true;
        } else {
          retained.push(item);
        }
      }

      let retainedBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
      while (retained.length > this.maxFailedItemsPerUser
        || retainedBytes > this.maxFailedBytesPerUser) {
        const oldest = retained.shift()!;
        retainedBytes -= oldest.bytes;
        target.delete(oldest.itemId);
        changed = true;
      }
    }
    return changed;
  }

  private load(): void {
    const primarySnapshot = this.readSnapshot(this.filePath);
    const backupSnapshot = this.readSnapshot(this.backupPath);
    const primary = this.decodeSnapshotCandidate(primarySnapshot);
    const backup = this.decodeSnapshotCandidate(backupSnapshot);
    if (primary.candidate || backup.candidate) {
      const useBackup = Boolean(backup.candidate)
        && (!primary.candidate
          || compareSnapshotFreshness(
            backup.candidate!.snapshot,
            primary.candidate.snapshot,
          ) > 0);
      const selected = (useBackup ? backup.candidate : primary.candidate)!;
      const { snapshot, loaded, normalized } = selected;
      this.revision = loaded.revision;
      const requiresMigration = loaded.changed
        || normalized.changed
        || snapshot.schemaVersion !== 2
        || !isNonNegativeSafeInteger(snapshot.revision);
      const requiresRepair = useBackup
        || (existsSync(this.filePath) && !primary.candidate)
        || (existsSync(this.backupPath) && !backup.candidate)
        || (primary.candidate !== undefined && !existsSync(this.backupPath))
        || (primary.candidate !== undefined
          && backup.candidate !== undefined
          && compareSnapshotFreshness(
            primary.candidate.snapshot,
            backup.candidate.snapshot,
          ) !== 0)
        || (primary.candidate !== undefined
          && backup.candidate !== undefined
          && !sameCanonicalState(primary.candidate.normalized, backup.candidate.normalized));
      if (requiresMigration) {
        this.persistState(normalized.items, normalized.nextSequence);
      } else if (requiresRepair) {
        this.persistRepairState(normalized.items, normalized.nextSequence);
      }
      this.publish(normalized.items, normalized.nextSequence);
      return;
    }
    const semanticError = primary.error ?? backup.error;
    if (semanticError) throw semanticError;
    if (existsSync(this.filePath) || existsSync(this.backupPath)) {
      throw new OutboxCorruptionError(this.filePath);
    }
  }

  private decodeSnapshotCandidate(snapshot: LegacySnapshot | undefined): {
    candidate?: DecodedSnapshotCandidate;
    error?: OutboxMigrationError;
  } {
    if (!snapshot) return {};
    try {
      const loaded = this.decodeSnapshot(snapshot);
      return {
        candidate: {
          snapshot,
          loaded,
          normalized: this.normalizeLoadedState(loaded),
        },
      };
    } catch (error) {
      if (error instanceof OutboxMigrationError) return { error };
      throw error;
    }
  }

  private readSnapshot(filePath: string): LegacySnapshot | undefined {
    if (!existsSync(filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as LegacySnapshot;
      if (!Array.isArray(parsed.items)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private decodeSnapshot(snapshot: LegacySnapshot): LoadedOutboxState {
    const items = new Map<string, OutboxItem>();
    const requiresStableIds = snapshot.schemaVersion === 2;
    let maxSequence = 0;
    let changed = !isNonNegativeSafeInteger(snapshot.revision);
    for (const [index, raw] of (snapshot.items ?? []).entries()) {
      if (!raw || typeof raw !== 'object') {
        throw new OutboxMigrationError(`invalid item at index ${index}: expected an object`);
      }
      const value = raw as Partial<OutboxItem>;
      if (typeof value.text !== 'string') {
        throw new OutboxMigrationError(`invalid item at index ${index}: text must be a string`);
      }
      const providedItemId = typeof value.itemId === 'string' && value.itemId.length > 0
        ? value.itemId
        : undefined;
      const providedClientId = typeof value.clientId === 'string' && value.clientId.length > 0
        ? value.clientId
        : undefined;
      if (requiresStableIds && providedItemId === undefined) {
        throw new OutboxMigrationError(`invalid schema-two item at index ${index}: itemId must be a nonempty string`);
      }
      if (requiresStableIds && providedClientId === undefined) {
        throw new OutboxMigrationError(`invalid schema-two item at index ${index}: clientId must be a nonempty string`);
      }
      const itemId = providedItemId ?? randomUUID();
      if (items.has(itemId)) {
        throw new OutboxMigrationError(`duplicate itemId at index ${index}: ${itemId}`);
      }
      const deliveryState = decodeDeliveryState(value, index, requiresStableIds, this.now());
      changed ||= deliveryState.changed;
      const candidateSequence = asPositiveSafeInteger(value.sequence);
      const sequence = candidateSequence !== undefined && candidateSequence > maxSequence
        ? candidateSequence
        : nextSafeSequence(maxSequence);
      const createdAt = asFiniteNumber(value.createdAt, this.now());
      const item: OutboxItem = {
        schemaVersion: 2,
        itemId,
        clientId: providedClientId ?? randomUUID(),
        sequence,
        kind: 'text',
        accountId: value.accountId || '',
        userId: value.userId || '',
        generation: asFiniteNumber(value.generation, 0),
        tokenVersion: asFiniteNumber(value.tokenVersion, 0),
        priority: deliveryState.priority,
        text: value.text,
        bytes: Buffer.byteLength(value.text, 'utf8'),
        createdAt,
        expiresAt: asFiniteNumber(value.expiresAt, createdAt + this.defaultTtlMs),
        state: deliveryState.state,
        ...(deliveryState.deliveryReceipt ? { deliveryReceipt: deliveryState.deliveryReceipt } : {}),
        ...(Object.hasOwn(deliveryState, 'continuationNoticeAttached')
          ? { continuationNoticeAttached: deliveryState.continuationNoticeAttached }
          : {}),
        ...(Object.hasOwn(deliveryState, 'recoveryRequired')
          ? { recoveryRequired: deliveryState.recoveryRequired }
          : {}),
        ...(value.terminalError ? { terminalError: value.terminalError } : {}),
        ...(deliveryState.failureKind ? { failureKind: deliveryState.failureKind } : {}),
        ...(deliveryState.failedAt !== undefined ? { failedAt: deliveryState.failedAt } : {}),
        ...(deliveryState.recoveryAttempts !== undefined
          ? { recoveryAttempts: deliveryState.recoveryAttempts }
          : {}),
      };
      items.set(item.itemId, item);
      maxSequence = sequence;
    }
    const persistedNextSequence = asPositiveSafeInteger(snapshot.nextSequence);
    return {
      revision: isNonNegativeSafeInteger(snapshot.revision) ? snapshot.revision : 0,
      nextSequence: persistedNextSequence !== undefined && persistedNextSequence > maxSequence
        ? persistedNextSequence
        : nextSafeSequence(maxSequence),
      items,
      changed,
    };
  }

  private normalizeLoadedState(state: LoadedOutboxState): NormalizedOutboxState {
    if (this.bodyChunkBytes === undefined || this.inboundItemLimit === undefined) {
      return { nextSequence: state.nextSequence, items: state.items, changed: false };
    }

    const ordered = [...state.items.values()]
      .sort((a, b) => a.sequence - b.sequence || a.itemId.localeCompare(b.itemId));
    const normalized: OutboxItem[] = [];
    let changed = false;

    for (let start = 0; start < ordered.length;) {
      const first = ordered[start];
      let end = start + 1;
      while (end < ordered.length && sameMigrationBatch(first, ordered[end])) end += 1;
      const batch = ordered.slice(start, end);
      const eligible = batch.length > this.inboundItemLimit
        && batch.every((item) => item.priority === 'final'
          && canRechunkPendingItem(item))
        && batch.some((item) => Buffer.byteLength(item.text, 'utf8') > this.bodyChunkBytes!);

      if (!eligible) {
        for (const item of batch) {
          if (!canRechunkPendingItem(item)
            || Buffer.byteLength(item.text, 'utf8') <= this.bodyChunkBytes) {
            normalized.push(item);
            continue;
          }
          const chunks = chunkUtf8Text(item.text, this.bodyChunkBytes);
          if (chunks.join('') !== item.text
            || chunks.some((chunk) => Buffer.byteLength(chunk, 'utf8') > this.bodyChunkBytes!)) {
            throw new OutboxMigrationError(
              `normalization could not preserve item ${item.itemId} within bodyChunkBytes`,
            );
          }
          normalized.push(...chunks.map((chunk, index): OutboxItem => ({
            ...item,
            itemId: index === 0 ? item.itemId : randomUUID(),
            clientId: index === 0 ? item.clientId : randomUUID(),
            text: chunk,
            bytes: Buffer.byteLength(chunk, 'utf8'),
          })));
          changed = true;
        }
        start = end;
        continue;
      }

      const text = batch.map((item) => item.text).join('');
      const chunks = chunkUtf8Text(text, this.bodyChunkBytes);
      if (chunks.join('') !== text
        || chunks.some((chunk) => Buffer.byteLength(chunk, 'utf8') > this.bodyChunkBytes!)) {
        throw new OutboxMigrationError(
          `normalization could not preserve text within bodyChunkBytes for account ${first.accountId}, user ${first.userId}`,
        );
      }

      const last = batch[batch.length - 1];
      normalized.push(...chunks.map((chunk, index): OutboxItem => {
        const base = batch[index] ?? last;
        return {
          ...base,
          schemaVersion: 2,
          itemId: index < batch.length ? base.itemId : randomUUID(),
          clientId: index < batch.length ? base.clientId : randomUUID(),
          text: chunk,
          bytes: Buffer.byteLength(chunk, 'utf8'),
        };
      }));
      changed = true;
      start = end;
    }

    if (!changed) {
      return { nextSequence: state.nextSequence, items: state.items, changed: false };
    }

    const firstSequence = ordered[0]?.sequence ?? 1;
    const lastSequence = firstSequence + normalized.length - 1;
    if (!Number.isSafeInteger(firstSequence)
      || firstSequence <= 0
      || !Number.isSafeInteger(lastSequence)
      || lastSequence >= Number.MAX_SAFE_INTEGER) {
      throw sequenceCapacityError();
    }
    const items = new Map<string, OutboxItem>();
    normalized.forEach((item, index) => {
      const resequenced = { ...item, sequence: firstSequence + index };
      items.set(resequenced.itemId, resequenced);
    });
    return {
      nextSequence: Math.max(state.nextSequence, nextSafeSequence(lastSequence)),
      items,
      changed: true,
    };
  }

  private persistState(items: Map<string, OutboxItem>, nextSequence: number): void {
    assertPersistableItems(items);
    assertPersistableSequences(items, nextSequence);
    const revision = this.revision + 1;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new OutboxMigrationError('revision capacity exhausted; no safe successor remains');
    }
    const payload: PersistedOutbox = { schemaVersion: 2, revision, nextSequence, items: [...items.values()] };
    const encoded = JSON.stringify(payload, null, 2);
    atomicWrite(this.backupPath, encoded);
    atomicWrite(this.filePath, encoded);
    this.revision = revision;
  }

  private persistRepairState(items: Map<string, OutboxItem>, nextSequence: number): void {
    assertPersistableItems(items);
    assertPersistableSequences(items, nextSequence);
    const revision = this.revision === Number.MAX_SAFE_INTEGER
      ? this.revision
      : this.revision + 1;
    const payload: PersistedOutbox = { schemaVersion: 2, revision, nextSequence, items: [...items.values()] };
    const encoded = JSON.stringify(payload, null, 2);
    atomicWrite(this.backupPath, encoded);
    atomicWrite(this.filePath, encoded);
    this.revision = revision;
  }

  private publish(items: Map<string, OutboxItem>, nextSequence: number): void {
    this.items.clear();
    for (const [itemId, item] of items) this.items.set(itemId, item);
    this.nextSequence = nextSequence;
  }
}

function sameMigrationBatch(left: OutboxItem, right: OutboxItem): boolean {
  return left.accountId === right.accountId
    && left.userId === right.userId
    && left.generation === right.generation
    && left.tokenVersion === right.tokenVersion
    && left.priority === right.priority;
}

function sameCanonicalState(left: NormalizedOutboxState, right: NormalizedOutboxState): boolean {
  return left.nextSequence === right.nextSequence
    && JSON.stringify([...left.items.values()]) === JSON.stringify([...right.items.values()]);
}

function compareSnapshotFreshness(left: LegacySnapshot, right: LegacySnapshot): number {
  const leftHasRevision = isNonNegativeSafeInteger(left.revision);
  const rightHasRevision = isNonNegativeSafeInteger(right.revision);
  if (leftHasRevision && rightHasRevision) {
    return left.revision! === right.revision! ? 0 : left.revision! > right.revision! ? 1 : -1;
  }
  if (leftHasRevision) return 1;
  if (rightHasRevision) return -1;
  const leftSequence = asFiniteNumber(left.nextSequence, 0);
  const rightSequence = asFiniteNumber(right.nextSequence, 0);
  return leftSequence === rightSequence ? 0 : leftSequence > rightSequence ? 1 : -1;
}

function canRechunkPendingItem(item: OutboxItem): boolean {
  return item.state === 'pending'
    && !item.deliveryReceipt
    && !item.recoveryRequired
    && !item.continuationNoticeAttached;
}

function decodeDeliveryState(
  value: Partial<OutboxItem>,
  index: number,
  strictSchemaTwo: boolean,
  now: number,
): DecodedDeliveryState {
  if (!strictSchemaTwo) {
    const ambiguous = value.recoveryRequired === true;
    const terminal = value.state === 'permanent-failure' || ambiguous;
    return {
      priority: isOutboxPriority(value.priority) ? value.priority : 'final',
      state: terminal ? 'permanent-failure' : 'pending',
      ...(isValidDeliveryReceipt(value.deliveryReceipt)
        ? { deliveryReceipt: {
            reservationId: value.deliveryReceipt.reservationId,
            quotaGeneration: value.deliveryReceipt.quotaGeneration,
          } }
        : {}),
      ...(value.continuationNoticeAttached ? { continuationNoticeAttached: true } : {}),
      ...(terminal ? {
        failureKind: ambiguous ? 'ambiguous-delivery' : 'legacy-unknown',
        failedAt: now,
        recoveryAttempts: 0,
      } : {}),
      changed: terminal,
    };
  }

  if (!isOutboxPriority(value.priority)) {
    throw new OutboxMigrationError(`invalid schema-two item at index ${index}: unknown priority`);
  }
  if (value.state !== 'pending' && value.state !== 'permanent-failure') {
    throw new OutboxMigrationError(`invalid schema-two item at index ${index}: unknown state`);
  }

  const raw = value as Record<string, unknown>;
  const deliveryReceipt = raw.deliveryReceipt;
  let decodedReceipt: OutboxItem['deliveryReceipt'];
  if (deliveryReceipt !== undefined) {
    if (!isValidDeliveryReceipt(deliveryReceipt)) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: malformed deliveryReceipt`);
    }
    decodedReceipt = {
      reservationId: deliveryReceipt.reservationId,
      quotaGeneration: deliveryReceipt.quotaGeneration,
    };
  }

  const hasRecoveryRequired = Object.hasOwn(raw, 'recoveryRequired');
  if (hasRecoveryRequired && typeof raw.recoveryRequired !== 'boolean') {
    throw new OutboxMigrationError(`invalid schema-two item at index ${index}: recoveryRequired must be boolean`);
  }
  const hasContinuationNotice = Object.hasOwn(raw, 'continuationNoticeAttached');
  if (hasContinuationNotice && typeof raw.continuationNoticeAttached !== 'boolean') {
    throw new OutboxMigrationError(
      `invalid schema-two item at index ${index}: continuationNoticeAttached must be boolean`,
    );
  }

  const hasFailureKind = Object.hasOwn(raw, 'failureKind');
  if (hasFailureKind && !isOutboxFailureKind(raw.failureKind)) {
    throw new OutboxMigrationError(`invalid schema-two item at index ${index}: unknown failureKind`);
  }
  const hasFailedAt = Object.hasOwn(raw, 'failedAt');
  if (hasFailedAt && (typeof raw.failedAt !== 'number'
    || !Number.isFinite(raw.failedAt)
    || raw.failedAt < 0)) {
    throw new OutboxMigrationError(`invalid schema-two item at index ${index}: failedAt must be finite and non-negative`);
  }
  const hasRecoveryAttempts = Object.hasOwn(raw, 'recoveryAttempts');
  if (hasRecoveryAttempts && (!Number.isSafeInteger(raw.recoveryAttempts)
    || (raw.recoveryAttempts as number) < 0)) {
    throw new OutboxMigrationError(
      `invalid schema-two item at index ${index}: recoveryAttempts must be a non-negative safe integer`,
    );
  }

  const legacyAmbiguous = raw.recoveryRequired === true;
  const terminal = value.state === 'permanent-failure' || legacyAmbiguous;
  const failureKind = terminal
    ? (legacyAmbiguous ? 'ambiguous-delivery' : (raw.failureKind as OutboxFailureKind | undefined)
      ?? 'legacy-unknown')
    : raw.failureKind as OutboxFailureKind | undefined;
  const failedAt = terminal
    ? (hasFailedAt ? raw.failedAt as number : now)
    : (hasFailedAt ? raw.failedAt as number : undefined);
  const recoveryAttempts = terminal
    ? (hasRecoveryAttempts ? raw.recoveryAttempts as number : 0)
    : (hasRecoveryAttempts ? raw.recoveryAttempts as number : undefined);
  const changed = legacyAmbiguous
    || (terminal && (!hasFailureKind || !hasFailedAt || !hasRecoveryAttempts));

  return {
    priority: value.priority,
    state: terminal ? 'permanent-failure' : value.state,
    ...(decodedReceipt ? { deliveryReceipt: decodedReceipt } : {}),
    ...(hasContinuationNotice
      ? { continuationNoticeAttached: raw.continuationNoticeAttached as boolean }
      : {}),
    ...(hasRecoveryRequired && !legacyAmbiguous
      ? { recoveryRequired: raw.recoveryRequired as boolean }
      : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(recoveryAttempts !== undefined ? { recoveryAttempts } : {}),
    changed,
  };
}

function isOutboxPriority(value: unknown): value is OutboxPriority {
  return typeof value === 'string' && OUTBOX_PRIORITIES.has(value as OutboxPriority);
}

function isOutboxFailureKind(value: unknown): value is OutboxFailureKind {
  return value === 'expired-before-delivery'
    || value === 'deterministic-rejection'
    || value === 'ambiguous-delivery'
    || value === 'legacy-unknown';
}

function isValidDeliveryReceipt(value: unknown): value is NonNullable<OutboxItem['deliveryReceipt']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.reservationId === 'string'
    && receipt.reservationId.length > 0
    && Number.isSafeInteger(receipt.quotaGeneration)
    && (receipt.quotaGeneration as number) >= 0;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeSafeIntegerOption(name: string, value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new OutboxMigrationError(`invalid ${name}: expected a non-negative safe integer`);
  }
  return normalized;
}

function asPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nextSafeSequence(sequence: number): number {
  const next = sequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(next) || next <= 0) {
    throw sequenceCapacityError();
  }
  return next;
}

function sequenceCapacityError(): OutboxMigrationError {
  return new OutboxMigrationError('sequence capacity exhausted; no safe nextSequence remains');
}

function assertPersistableItems(items: Map<string, OutboxItem>): void {
  let index = 0;
  for (const [itemId, item] of items) {
    if (item.schemaVersion !== 2) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: schemaVersion must be 2`);
    }
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: map key must be a nonempty string`);
    }
    if (typeof item.itemId !== 'string' || item.itemId.length === 0) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: itemId must be a nonempty string`);
    }
    if (itemId !== item.itemId) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: map key must equal itemId`);
    }
    if (typeof item.clientId !== 'string' || item.clientId.length === 0) {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: clientId must be a nonempty string`);
    }
    if (typeof item.text !== 'string') {
      throw new OutboxMigrationError(`invalid schema-two item at index ${index}: text must be a string`);
    }
    decodeDeliveryState(item, index, true, Date.now());
    index += 1;
  }
}

function assertPersistableSequences(items: Map<string, OutboxItem>, nextSequence: number): void {
  let previousSequence = 0;
  for (const item of items.values()) {
    if (asPositiveSafeInteger(item.sequence) === undefined || item.sequence <= previousSequence) {
      throw new OutboxMigrationError(
        'persisted sequence invariant failed: item sequences must be positive, safe, unique, and strictly increasing',
      );
    }
    previousSequence = item.sequence;
  }
  if (asPositiveSafeInteger(nextSequence) === undefined || nextSequence <= previousSequence) {
    throw new OutboxMigrationError(
      'persisted sequence invariant failed: nextSequence must be safe and greater than every item sequence',
    );
  }
}
