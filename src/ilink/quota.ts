import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export interface QuotaLimits {
  maxItemsPerWindow: number;
  maxBytes?: number;
  maxItems?: number;
  finalReserveItems?: number;
  finalReserveBytes?: number;
  maxItemsPerToken?: number;
  maxIntermediateItemsPerToken?: number;
  finalReserveItemsPerToken?: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxItemsPerWindow: 10,
  maxBytes: 200_000,
  maxItems: 100,
  finalReserveItems: 0,
  finalReserveBytes: 2_000,
  maxItemsPerToken: 10,
  maxIntermediateItemsPerToken: 10,
  finalReserveItemsPerToken: 0,
};

export type QuotaPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface QuotaReservation {
  reservationId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  items: number;
  bytes: number;
  priority: QuotaPriority;
}

export interface QuotaContext {
  generation: number;
  tokenVersion: number;
}

export interface DeliveryConfirmation {
  reservationId: string;
  userId: string;
  itemId: string;
  quotaGeneration: number;
  bytes: number;
}

export type ReserveResult =
  | { allowed: false; reason: 'final-reserved' | 'budget-exhausted' | 'item-too-large' | 'intermediate-budget' | 'token-budget-exhausted' }
  | { allowed: true; reservation: QuotaReservation };

interface UserQuotaState {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  tokenFingerprint?: string;
  seenInboundIds: string[];
  pendingInboundIds: string[];
  sentItems: number;
  sentBytes: number;
  confirmedItemIds: string[];
  reservedItems: number;
  reservedBytes: number;
  reservations: Record<string, QuotaReservation>;
  rateBackoffUntil: number;
}

interface PersistedQuota {
  schemaVersion: 1;
  users: Record<string, UserQuotaState>;
}

export interface InboundResult {
  duplicate: boolean;
  generation: number;
  inboundGeneration: number;
  tokenVersion: number;
  remainingItems: number;
}

export interface QuotaSnapshot {
  accountId: string;
  userId: string;
  generation: number;
  inboundGeneration: number;
  tokenVersion: number;
  sentItems: number;
  sentBytes: number;
  maxItemsPerWindow: number;
  remainingItems: number;
  rateBackoffUntil: number;
  reservedItems: number;
  reservedBytes: number;
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyState(accountId: string, userId: string): UserQuotaState {
  return {
    accountId,
    userId,
    generation: 0,
    tokenVersion: 0,
    seenInboundIds: [],
    pendingInboundIds: [],
    sentItems: 0,
    sentBytes: 0,
    confirmedItemIds: [],
    reservedItems: 0,
    reservedBytes: 0,
    reservations: {},
    rateBackoffUntil: 0,
  };
}

function normalizeMaxItemsPerWindow(limits: Partial<QuotaLimits>): number {
  const configured = limits.maxItemsPerWindow
    ?? limits.maxItemsPerToken
    ?? limits.maxItems
    ?? DEFAULT_QUOTA_LIMITS.maxItemsPerWindow;
  return typeof configured === 'number' && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_QUOTA_LIMITS.maxItemsPerWindow;
}

export class QuotaManager {
  private readonly users = new Map<string, UserQuotaState>();
  private readonly foreignUsers = new Map<string, UserQuotaState>();
  private readonly activeInboundIds = new Set<string>();
  private readonly limits: QuotaLimits;

  constructor(
    private readonly filePath: string,
    private readonly accountId: string,
    limits: Partial<QuotaLimits> = {},
  ) {
    this.limits = {
      ...DEFAULT_QUOTA_LIMITS,
      ...limits,
      maxItemsPerWindow: normalizeMaxItemsPerWindow(limits),
      maxBytes: Math.max(1, Math.floor(limits.maxBytes ?? DEFAULT_QUOTA_LIMITS.maxBytes!)),
      finalReserveItems: Math.max(0, Math.floor(limits.finalReserveItems ?? DEFAULT_QUOTA_LIMITS.finalReserveItems!)),
      finalReserveBytes: Math.max(0, Math.floor(limits.finalReserveBytes ?? DEFAULT_QUOTA_LIMITS.finalReserveBytes!)),
      maxItemsPerToken: Math.max(1, Math.floor(limits.maxItemsPerToken ?? DEFAULT_QUOTA_LIMITS.maxItemsPerToken!)),
      maxIntermediateItemsPerToken: Math.max(0, Math.floor(limits.maxIntermediateItemsPerToken ?? DEFAULT_QUOTA_LIMITS.maxIntermediateItemsPerToken!)),
      finalReserveItemsPerToken: Math.max(0, Math.floor(limits.finalReserveItemsPerToken ?? DEFAULT_QUOTA_LIMITS.finalReserveItemsPerToken!)),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  getMaxItemsPerWindow(): number {
    return this.limits.maxItemsPerWindow;
  }

  recordInbound(userId: string, messageId: string | number, contextToken: string): InboundResult {
    const state = this.getState(userId);
    const id = String(messageId);
    const inboundKey = `${userId}:${id}`;
    if (state.seenInboundIds.includes(id) || this.activeInboundIds.has(inboundKey)) {
      return this.inboundResult(state, true);
    }

    const isRetry = state.pendingInboundIds.includes(id);
    if (isRetry) {
      this.activeInboundIds.add(inboundKey);
      return this.inboundResult(state, false);
    }

    state.pendingInboundIds.push(id);
    this.activeInboundIds.add(inboundKey);
    state.generation += 1;
    state.sentItems = 0;
    state.sentBytes = 0;
    state.confirmedItemIds = [];
    state.reservedItems = 0;
    state.reservedBytes = 0;
    state.reservations = {};
    if (contextToken) {
      const fingerprint = tokenFingerprint(contextToken);
      if (state.tokenFingerprint !== fingerprint) {
        state.tokenFingerprint = fingerprint;
        state.tokenVersion += 1;
        state.rateBackoffUntil = 0;
      }
    }
    this.persist();
    return this.inboundResult(state, false);
  }

  completeInbound(userId: string, messageId: string | number): boolean {
    const state = this.getState(userId);
    const id = String(messageId);
    const inboundKey = `${userId}:${id}`;
    const pendingIndex = state.pendingInboundIds.indexOf(id);
    if (pendingIndex < 0 && !this.activeInboundIds.has(inboundKey)) return false;

    this.activeInboundIds.delete(inboundKey);
    if (pendingIndex >= 0) state.pendingInboundIds.splice(pendingIndex, 1);
    if (!state.seenInboundIds.includes(id)) {
      state.seenInboundIds.push(id);
      if (state.seenInboundIds.length > 1000) state.seenInboundIds.shift();
    }
    this.persist();
    return true;
  }

  abandonInbound(userId: string, messageId: string | number): boolean {
    return this.activeInboundIds.delete(`${userId}:${String(messageId)}`);
  }

  confirmSend(userId: string, itemId: string, bytes = 0): boolean {
    const state = this.getState(userId);
    const confirmationKey = `${state.generation}:${itemId}`;
    if (state.generation === 0 || state.confirmedItemIds.includes(confirmationKey)) return false;
    if (state.sentItems >= this.limits.maxItemsPerWindow) return false;
    state.confirmedItemIds.push(confirmationKey);
    state.sentItems += 1;
    state.sentBytes += Math.max(0, bytes);
    this.persist();
    return true;
  }

  reserve(userId: string, bytes: number, priority: QuotaPriority, context?: QuotaContext): ReserveResult {
    const state = this.getState(userId);
    if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative integer');
    const amount = bytes;
    if (state.generation === 0) return { allowed: false, reason: 'budget-exhausted' };
    if (amount > (this.limits.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
      return { allowed: false, reason: 'item-too-large' };
    }

    const usedItems = state.sentItems + state.reservedItems;
    const usedBytes = state.sentBytes + state.reservedBytes;
    const priorityLimit = this.maxItemsByPriority()[priority];
    if (usedItems + 1 > priorityLimit) {
      if (priority === 'intermediate' || priority === 'activity') {
        const intermediateLimit = Math.min(
          this.limits.maxItemsPerWindow,
          Math.max(0, this.limits.maxIntermediateItemsPerToken ?? this.limits.maxItemsPerWindow),
        );
        return { allowed: false, reason: usedItems + 1 > intermediateLimit
          ? 'intermediate-budget'
          : 'final-reserved' };
      }
      return { allowed: false, reason: priority === 'final' || priority === 'control'
        ? 'token-budget-exhausted'
        : 'final-reserved' };
    }
    const reserveBytes = priority === 'final' ? 0 : Math.max(0, this.limits.finalReserveBytes ?? 0);
    if (usedBytes + amount > (this.limits.maxBytes ?? Number.MAX_SAFE_INTEGER) - reserveBytes) {
      return { allowed: false, reason: priority === 'final' ? 'budget-exhausted' : 'final-reserved' };
    }

    const reservation: QuotaReservation = {
      reservationId: randomUUID(),
      userId,
      generation: context?.generation ?? state.generation,
      tokenVersion: context?.tokenVersion ?? state.tokenVersion,
      items: 1,
      bytes: amount,
      priority,
    };
    state.reservations[reservation.reservationId] = reservation;
    state.reservedItems += 1;
    state.reservedBytes += amount;
    this.persist();
    return { allowed: true, reservation };
  }

  commit(reservationId: string): boolean {
    const found = this.findReservation(reservationId);
    if (!found) return false;
    const { state, reservation } = found;
    delete state.reservations[reservationId];
    state.reservedItems = Math.max(0, state.reservedItems - reservation.items);
    state.reservedBytes = Math.max(0, state.reservedBytes - reservation.bytes);
    state.sentItems += reservation.items;
    state.sentBytes += reservation.bytes;
    state.confirmedItemIds.push(`${state.generation}:${reservationId}`);
    this.persist();
    return true;
  }

  commitDelivery(confirmation: DeliveryConfirmation): boolean {
    const state = this.getState(confirmation.userId);
    const found = this.findReservation(confirmation.reservationId);
    if (found && found.state !== state) return false;

    const nextState: UserQuotaState = {
      ...state,
      confirmedItemIds: [...state.confirmedItemIds],
      reservations: { ...state.reservations },
    };
    let changed = false;
    if (found) {
      delete nextState.reservations[confirmation.reservationId];
      nextState.reservedItems = Math.max(0, nextState.reservedItems - found.reservation.items);
      nextState.reservedBytes = Math.max(0, nextState.reservedBytes - found.reservation.bytes);
      changed = true;
    }

    const confirmationKey = `${confirmation.quotaGeneration}:${confirmation.itemId}`;
    if (state.generation !== confirmation.quotaGeneration || state.confirmedItemIds.includes(confirmationKey)) {
      if (changed) this.persistUserState(confirmation.userId, nextState);
      return false;
    }

    nextState.confirmedItemIds.push(confirmationKey);
    let committed = false;
    if (nextState.sentItems < this.limits.maxItemsPerWindow) {
      nextState.sentItems += 1;
      nextState.sentBytes += Math.max(0, confirmation.bytes);
      committed = true;
    }
    this.persistUserState(confirmation.userId, nextState);
    return committed;
  }

  release(reservationId: string): boolean {
    const found = this.findReservation(reservationId);
    if (!found) return false;
    const { state, reservation } = found;
    delete state.reservations[reservationId];
    state.reservedItems = Math.max(0, state.reservedItems - reservation.items);
    state.reservedBytes = Math.max(0, state.reservedBytes - reservation.bytes);
    this.persist();
    return true;
  }

  remaining(userId: string): number {
    const state = this.users.get(userId);
    if (!state || state.generation === 0) return 0;
    return Math.max(0, this.limits.maxItemsPerWindow - state.sentItems - state.reservedItems);
  }

  maxItemsByPriority(): Record<QuotaPriority, number> {
    const maxItems = this.limits.maxItemsPerWindow;
    const finalReserveItems = Math.max(0, this.limits.finalReserveItems ?? 0);
    const intermediateLimit = Math.min(
      maxItems,
      Math.max(0, maxItems - finalReserveItems),
      Math.max(0, this.limits.maxIntermediateItemsPerToken ?? maxItems),
    );
    const mediaLimit = Math.min(
      maxItems,
      Math.max(0, maxItems - Math.max(
        finalReserveItems,
        this.limits.finalReserveItemsPerToken ?? 0,
      )),
    );
    return {
      final: maxItems,
      control: maxItems,
      media: mediaLimit,
      intermediate: intermediateLimit,
      activity: intermediateLimit,
    };
  }

  canOpenWindow(userId: string): boolean {
    const state = this.users.get(userId);
    return Boolean(state && state.generation > 0 && Date.now() >= state.rateBackoffUntil && this.remaining(userId) > 0);
  }

  markRateBackoff(userId: string, durationMs: number): number {
    const state = this.getState(userId);
    state.rateBackoffUntil = Math.max(state.rateBackoffUntil, Date.now() + Math.max(0, durationMs));
    this.persist();
    return state.rateBackoffUntil;
  }

  noteRateBackoff(userId: string, until: number): void {
    const state = this.getState(userId);
    state.rateBackoffUntil = Math.max(state.rateBackoffUntil, until);
    this.persist();
  }

  getRateBackoff(userId: string): { until: number; generation: number; tokenVersion: number } {
    const state = this.getState(userId);
    return { until: state.rateBackoffUntil, generation: state.generation, tokenVersion: state.tokenVersion };
  }

  clearRateBackoff(userId: string): boolean {
    const state = this.getState(userId);
    if (state.rateBackoffUntil === 0) return false;
    state.rateBackoffUntil = 0;
    this.persist();
    return true;
  }

  snapshot(userId: string): QuotaSnapshot {
    const state = this.getState(userId);
    return {
      accountId: state.accountId,
      userId: state.userId,
      generation: state.generation,
      inboundGeneration: state.generation,
      tokenVersion: state.tokenVersion,
      sentItems: state.sentItems,
      sentBytes: state.sentBytes,
      maxItemsPerWindow: this.limits.maxItemsPerWindow,
      remainingItems: this.remaining(userId),
      rateBackoffUntil: state.rateBackoffUntil,
      reservedItems: state.reservedItems,
      reservedBytes: state.reservedBytes,
    };
  }

  private inboundResult(state: UserQuotaState, duplicate: boolean): InboundResult {
    return {
      duplicate,
      generation: state.generation,
      inboundGeneration: state.generation,
      tokenVersion: state.tokenVersion,
      remainingItems: this.remaining(state.userId),
    };
  }

  private findReservation(reservationId: string): { state: UserQuotaState; reservation: QuotaReservation } | undefined {
    for (const state of this.users.values()) {
      const reservation = state.reservations[reservationId];
      if (reservation) return { state, reservation };
    }
    return undefined;
  }

  private getState(userId: string): UserQuotaState {
    let state = this.users.get(userId);
    if (!state) {
      state = emptyState(this.accountId, userId);
      this.users.set(userId, state);
    }
    return state;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedQuota>;
      if (!parsed.users || typeof parsed.users !== 'object') return;
      for (const [key, raw] of Object.entries(parsed.users)) {
        if (!raw || typeof raw !== 'object') continue;
        const value = raw as Partial<UserQuotaState>;
        const userId = typeof value.userId === 'string' ? value.userId : key;
        if (value.accountId && value.accountId !== this.accountId) {
          this.foreignUsers.set(key, value as UserQuotaState);
          continue;
        }
        const state: UserQuotaState = {
          ...emptyState(this.accountId, userId),
          ...value,
          accountId: this.accountId,
          userId,
          generation: asNumber(value.generation ?? (value as any).inboundGeneration, 0),
          tokenVersion: asNumber(value.tokenVersion, 0),
          seenInboundIds: Array.isArray(value.seenInboundIds) ? value.seenInboundIds.map(String) : [],
          pendingInboundIds: Array.isArray(value.pendingInboundIds) ? value.pendingInboundIds.map(String) : [],
          sentItems: asNumber(value.sentItems, 0),
          sentBytes: asNumber(value.sentBytes, 0),
          confirmedItemIds: Array.isArray(value.confirmedItemIds) ? value.confirmedItemIds.map(String) : [],
          reservedItems: 0,
          reservedBytes: 0,
          reservations: {},
          rateBackoffUntil: asNumber(value.rateBackoffUntil, 0),
        };
        this.users.set(userId, state);
      }
    } catch {
      // A corrupt quota snapshot is non-authoritative; start conservatively.
    }
  }

  private persist(): void {
    const users: Record<string, UserQuotaState> = {};
    for (const [key, state] of this.foreignUsers) users[key] = state;
    if (existsSync(this.filePath)) {
      try {
        const current = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedQuota>;
        if (current.schemaVersion === 1 && current.users && typeof current.users === 'object') {
          for (const [key, state] of Object.entries(current.users)) {
            if (state?.accountId && state.accountId !== this.accountId) users[key] = state;
          }
        }
      } catch {
        // Keep the valid in-memory snapshot when the current file cannot be merged.
      }
    }
    for (const [userId, state] of this.users) users[`${this.accountId}\u0000${userId}`] = state;
    const payload: PersistedQuota = { schemaVersion: 1, users };
    atomicWrite(this.filePath, JSON.stringify(payload, null, 2));
  }

  private persistUserState(userId: string, nextState: UserQuotaState): void {
    const previous = this.users.get(userId);
    this.users.set(userId, nextState);
    try {
      this.persist();
    } catch (err) {
      if (previous) this.users.set(userId, previous);
      else this.users.delete(userId);
      throw err;
    }
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
