# Issue 26 Outbox Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent retained terminal outbox failures from exhausting active delivery capacity while safely recovering only recent messages that expired before delivery.

**Architecture:** `OutboxStore` owns terminal-failure classification, bounded retention, conservative migration, and atomic FIFO-tail requeueing. `ILinkClient` classifies send failures, asks the store for eligible recovery after each fresh inbound, emits metadata-only diagnostics, and continues the already-planned FIFO suffix after terminal failures without resending ambiguous items.

**Tech Stack:** TypeScript, Node.js built-in test runner, filesystem-backed JSON snapshots, existing iLink delivery planner and quota manager.

---

### Task 1: Establish the isolated baseline and plan

**Files:**
- Create: `docs/superpowers/plans/2026-08-12-issue-26-outbox-liveness.md`

- [x] **Step 1: Create the isolated worktree at the reviewed base**

Run: `git worktree add C:\tmp\cli-in-wechat-worktrees\issue-26-outbox-liveness -b codex/fix-outbox-terminal-capacity 5e5f1daf399954092b5718f2c34a7c7b6ddefa29`

Expected: the branch is created at the exact `upstream/main` commit supplied for Issue #26.

- [x] **Step 2: Install the locked dependency graph**

Run: `npm ci`

Expected: install and the package `prepare` build exit successfully without modifying tracked dependency metadata.

- [x] **Step 3: Verify the baseline suite**

Run: `npm test`

Expected: 255 tests, 253 passing, 2 platform skips, 0 failures.

- [ ] **Step 4: Commit the reviewed implementation plan**

```powershell
git add docs/superpowers/plans/2026-08-12-issue-26-outbox-liveness.md
git commit -m "docs: plan outbox terminal failure liveness fix"
```

Expected: one documentation-only commit on `codex/fix-outbox-terminal-capacity`.

### Task 2: Separate active capacity from bounded terminal retention

**Files:**
- Modify: `test/outbox.test.ts`
- Modify: `src/ilink/outbox.ts`

- [ ] **Step 1: Write failing capacity and retention tests**

Add tests that construct `OutboxStore` with small limits and assert:

```ts
test('terminal failures do not consume active item or byte capacity', () => {
  const store = new OutboxStore(tempPath(), {
    maxItemsPerUser: 1,
    maxBytesPerUser: 16,
    maxFailedItemsPerUser: 10,
    maxFailedBytesPerUser: 1_000,
  });
  const failed = store.enqueue(input({ itemId: 'failed', text: 'old body' }));
  store.markPermanentFailure(failed.itemId, { httpStatus: 400 }, 'deterministic-rejection');
  assert.doesNotThrow(() => store.enqueue(input({ itemId: 'active', text: 'new body' })));
});
```

Also assert that failed retention removes records older than `failedRetentionMs`, then removes the oldest remaining failures until both item and byte budgets fit, while preserving every pending record and pending delivery receipt.

- [ ] **Step 2: Run the targeted test file and observe RED**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: FAIL because failed-budget options, typed failure kinds, and state-isolated active capacity do not exist.

- [ ] **Step 3: Implement minimal terminal metadata and retention**

In `src/ilink/outbox.ts`, add:

```ts
export type OutboxFailureKind =
  | 'expired-before-delivery'
  | 'deterministic-rejection'
  | 'ambiguous-delivery'
  | 'legacy-unknown';

export interface OutboxItem {
  // existing fields remain unchanged
  failureKind?: OutboxFailureKind;
  failedAt?: number;
  recoveryAttempts?: number;
}
```

Add options defaulting to 100 terminal items, 200,000 terminal bytes, and 14 days. Make active capacity sum only `state === 'pending'`. On terminal transitions, stamp `failureKind` and `failedAt`; apply expiry-first then oldest-first failed retention per account/user. Retention must only delete `state === 'permanent-failure'` records and must never delete pending or receipt-bearing pending records.

- [ ] **Step 4: Run the targeted test and observe GREEN**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: all outbox tests pass.

- [ ] **Step 5: Commit the capacity and retention slice**

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "fix: isolate outbox terminal failure capacity"
```

### Task 3: Migrate failure metadata conservatively and idempotently

**Files:**
- Modify: `test/outbox.test.ts`
- Modify: `src/ilink/outbox.ts`

- [ ] **Step 1: Write failing migration tests**

Add snapshots for: an old schema-two permanent failure without metadata, an old `pending + recoveryRequired` record, and a current classified failure. Assert:

```ts
assert.equal(legacyFailure.failureKind, 'legacy-unknown');
assert.equal(legacyFailure.state, 'permanent-failure');
assert.equal(legacyRecovery.failureKind, 'ambiguous-delivery');
assert.equal(legacyRecovery.state, 'permanent-failure');
assert.equal(legacyRecovery.recoveryRequired, undefined);
```

Capture the first migrated file and revision, reload it, and assert byte-for-byte equality and no second revision increment. Assert malformed new metadata is rejected before persistence.

- [ ] **Step 2: Run the targeted test file and observe RED**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: FAIL because metadata is not decoded and legacy recovery remains a resendable pending record.

- [ ] **Step 3: Implement conservative, strict, idempotent decoding**

Teach snapshot decoding to report whether it migrated an item. Map metadata-free failures to `legacy-unknown`; map any old truthy `recoveryRequired` pending item to terminal `ambiguous-delivery`; never infer that either is retryable. Validate known failure-kind enums, finite non-negative `failedAt`, and non-negative safe-integer `recoveryAttempts`. Persist exactly once when migration changed the decoded state.

- [ ] **Step 4: Run the targeted test and observe GREEN**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: all outbox tests pass, including strict schema-two reload checks.

- [ ] **Step 5: Commit the migration slice**

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "fix: migrate terminal outbox failures safely"
```

### Task 4: Requeue only eligible expired failures at the FIFO tail

**Files:**
- Modify: `test/outbox.test.ts`
- Modify: `src/ilink/outbox.ts`

- [ ] **Step 1: Write failing recovery-policy tests**

Use an injected clock and assert that recovery selects only `expired-before-delivery` failures with no receipt, age at most 14 days, fewer than three recovery attempts, and elapsed backoff of 0, 5 minutes, then 30 minutes. Assert deterministic, ambiguous, legacy, receipt-bearing, stale, exhausted, and not-yet-due records stay terminal.

Add a batch test with active prefix `active-1`, eligible failures `expired-1` and `expired-2`, and active suffix `active-2`. After recovery, assert pending FIFO is `active-1`, `active-2`, `expired-1`, `expired-2`; identities and payloads are unchanged; attempts increment; and reload preserves the order and counters.

- [ ] **Step 2: Run the targeted test file and observe RED**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: FAIL because there is no policy-constrained atomic recovery operation or tail resequencing.

- [ ] **Step 3: Implement minimal atomic recovery**

Replace the unrestricted predicate requeue helper with a store operation scoped by account and user. Sort eligible terminal records by existing FIFO sequence, capacity-check them against active pending records, remove and reinsert each with a fresh monotonically increasing sequence, `state: 'pending'`, incremented `recoveryAttempts`, renewed TTL, and preserved item/client IDs and payload. Return structured metadata containing only `itemId`, `kind`, `ageMs`, and `attempt` for diagnostics.

- [ ] **Step 4: Run the targeted test and observe GREEN**

Run: `node --import tsx --test test/outbox.test.ts`

Expected: all outbox recovery and persistence tests pass.

- [ ] **Step 5: Commit the recovery-policy slice**

```powershell
git add src/ilink/outbox.ts test/outbox.test.ts
git commit -m "fix: recover eligible expired outbox items"
```

### Task 5: Integrate fresh-inbound recovery and terminal FIFO liveness

**Files:**
- Modify: `test/client-send.test.ts`
- Modify: `src/ilink/client.ts`

- [ ] **Step 1: Write failing client behavior tests**

Add tests that assert:

```ts
// A fresh inbound requeues an eligible expired record exactly once and sends it
// through the existing router recovery path. A poll replay does neither.

// Restart retains recoveryAttempts, so the next eligibility decision observes
// the persisted 5-minute or 30-minute backoff.

// An ambiguous first item becomes terminal, is not resent on later inbound,
// and the already-planned FIFO suffix is attempted in the same drain.

// HTTP 400 terminalizes the current item and sends the suffix in the same
// recoverPending call, without a second explicit recovery call.
```

Update pre-Issue-26 ambiguous assertions from `pending + recoveryRequired` to `failed + failureKind === 'ambiguous-delivery'` while preserving client ID and frozen payload assertions.

- [ ] **Step 2: Run the targeted client test and observe RED**

Run: `node --import tsx --test test/client-send.test.ts`

Expected: FAIL because fresh inbound still clears all recovery locks, ambiguous records remain pending, and terminal catches break the drain.

- [ ] **Step 3: Implement the minimal client integration**

In `processFreshMessage`, remove `clearRecoveryRequiredForUser`; invoke the scoped expired-failure recovery only after durable fresh-inbound quota/token bookkeeping, and record metadata-only recovery diagnostics. In `deliverPendingNow`, classify deterministic and ambiguous failures with explicit kinds, terminalize both, append the corresponding result, and `continue` to the planned suffix. Keep rate-limit/quota reserve paths as `break`, and never retry the current ambiguous item.

- [ ] **Step 4: Run client and outbox tests and observe GREEN**

Run: `node --import tsx --test test/outbox.test.ts test/client-send.test.ts`

Expected: all targeted tests pass; request counts prove no ambiguous resend and same-drain suffix progress.

- [ ] **Step 5: Commit the client integration slice**

```powershell
git add src/ilink/client.ts test/client-send.test.ts
git commit -m "fix: keep terminal failures from blocking fifo delivery"
```

### Task 6: Lock down diagnostic redaction and router mode contracts

**Files:**
- Modify: `test/diagnostics.test.ts`
- Modify: `test/router.test.ts`
- Modify: `src/ilink/diagnostics.ts` only if the failing test exposes a redaction gap

- [ ] **Step 1: Write failing diagnostic privacy test**

Record a recovery event containing allowed `count`, `failureKind`, `ageMs`, and `attempt` fields plus forbidden `text`, `token`, and `rawBody` values. Assert the allowed metadata survives and none of the three secrets appears in the JSON line. Treat `rawBody` as sensitive structured payload rather than truncating it.

- [ ] **Step 2: Run diagnostics tests and observe RED**

Run: `node --import tsx --test test/diagnostics.test.ts`

Expected: FAIL because `rawBody` is not currently a protected diagnostic key.

- [ ] **Step 3: Implement the minimal redaction addition**

Add normalized `rawbody` to the sensitive diagnostic key set so it is replaced with `***`; retain existing counter and enum fields unchanged.

- [ ] **Step 4: Run diagnostics tests and observe GREEN**

Run: `node --import tsx --test test/diagnostics.test.ts`

Expected: all diagnostics tests pass.

- [ ] **Step 5: Add and run mode regression tests without router production changes**

Add a table-driven router test for `compact`, `normal`, and `verbose` that captures `sendText` calls and asserts each mode's existing content, order, priority, and continuation-related final delivery behavior. Do not modify `src/bridge/router.ts` unless the regression exposes an Issue-26-caused behavioral change.

Run: `node --import tsx --test test/router.test.ts`

Expected: all three mode cases pass immediately against unchanged router production code, documenting that Issue #26 does not alter presentation behavior.

- [ ] **Step 6: Commit diagnostics and mode coverage**

```powershell
git add src/ilink/diagnostics.ts test/diagnostics.test.ts test/router.test.ts
git commit -m "test: preserve delivery diagnostics and message modes"
```

### Task 7: Verify scope, security, and release the branch for review

**Files:**
- Verify only: `src/ilink/outbox.ts`
- Verify only: `src/ilink/client.ts`
- Verify only: `src/ilink/diagnostics.ts`
- Verify only: `test/outbox.test.ts`
- Verify only: `test/client-send.test.ts`
- Verify only: `test/diagnostics.test.ts`
- Verify only: `test/router.test.ts`
- Verify only: `docs/superpowers/plans/2026-08-12-issue-26-outbox-liveness.md`

- [ ] **Step 1: Run fresh full verification**

```powershell
npm test
npm run typecheck
npm run build
git diff --check upstream/main...HEAD
```

Expected: every command exits zero; test output has zero failures.

- [ ] **Step 2: Audit the branch diff and sensitive-data surface**

```powershell
git diff --stat upstream/main...HEAD
git diff --name-only upstream/main...HEAD
git diff upstream/main...HEAD -- src/ilink test docs/superpowers/plans
rg -n "context_token|bot_token|authorization|rawBody|text:" src/ilink/diagnostics.ts src/ilink/client.ts test/diagnostics.test.ts
git status --short --branch
```

Expected: only the scoped files changed; no credentials, message bodies, raw response bodies, media persistence, router lifecycle, CLI commands, or unrelated refactors were introduced.

- [ ] **Step 3: Commit any verification-only correction via its own RED/GREEN cycle**

If verification exposes a defect, first add or identify the failing focused test, observe it fail, implement the smallest correction, rerun focused and full verification, then commit with a scoped message. If no correction is needed, create no empty commit.

- [ ] **Step 4: Push the reviewed branch without creating a PR**

Run: `git push --set-upstream origin codex/fix-outbox-terminal-capacity`

Expected: origin tracking is configured and the remote SHA matches local `HEAD`. Do not create a pull request; independent dual review occurs first.
