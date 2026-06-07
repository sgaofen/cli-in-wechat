import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchWithRetry,
  isRetryableNetworkError,
  describeNetworkError,
} from '../src/utils/http.js';

// ─── Helpers ────────────────────────────────────────────────

/** Build an error shaped like a real Node/undici fetch failure: TypeError with a cause carrying the code. */
function fetchFailure(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

function okResponse(body = '{}'): Response {
  return new Response(body, { status: 200 });
}

/** Swap out global fetch for a queue of behaviors, restoring it afterwards. */
async function withMockFetch(
  behaviors: Array<() => Promise<Response>>,
  fn: (calls: { count: number }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    const behavior = behaviors[Math.min(calls.count, behaviors.length - 1)];
    calls.count++;
    return behavior();
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const FAST = { retryDelayMs: 1, maxRetryDelayMs: 4 } as const;

// ─── isRetryableNetworkError ────────────────────────────────

test('isRetryableNetworkError: classifies the issue #18 ECONNRESET as retryable', () => {
  assert.equal(isRetryableNetworkError(fetchFailure('ECONNRESET')), true);
});

test('isRetryableNetworkError: ETIMEDOUT / EAI_AGAIN / undici socket are retryable', () => {
  assert.equal(isRetryableNetworkError(fetchFailure('ETIMEDOUT')), true);
  assert.equal(isRetryableNetworkError(fetchFailure('EAI_AGAIN')), true);
  assert.equal(isRetryableNetworkError(fetchFailure('UND_ERR_SOCKET')), true);
});

test('isRetryableNetworkError: TimeoutError (AbortSignal.timeout) is retryable', () => {
  assert.equal(isRetryableNetworkError(new DOMException('timed out', 'TimeoutError')), true);
});

test('isRetryableNetworkError: "socket hang up" message is retryable', () => {
  assert.equal(isRetryableNetworkError(new Error('socket hang up')), true);
});

test('isRetryableNetworkError: a plain non-network error is NOT retryable', () => {
  assert.equal(isRetryableNetworkError(new Error('bad json')), false);
  assert.equal(isRetryableNetworkError(fetchFailure('ERR_INVALID_ARG')), false);
});

test('isRetryableNetworkError: sees the code through a DOUBLE-wrapped error (the one fetchWithRetry rethrows)', () => {
  // fetchWithRetry rethrows `new Error(describeNetworkError(err), { cause: err })`, so the
  // real code ends up at .cause.cause.code. A one-level lookup would miss it and the
  // issue-#18 ECONNRESET would be mis-classified as non-retryable. (regression guard)
  const inner = fetchFailure('ECONNRESET'); // TypeError, cause.code = ECONNRESET
  const doubleWrapped = new Error(describeNetworkError(inner), { cause: inner });
  assert.equal(isRetryableNetworkError(doubleWrapped), true);
});

test('describeNetworkError: still actionable on a double-wrapped error (code found, no garble)', () => {
  const inner = fetchFailure('ECONNRESET');
  const doubleWrapped = new Error(describeNetworkError(inner), { cause: inner });
  const msg = describeNetworkError(doubleWrapped);
  assert.match(msg, /ECONNRESET/);
  assert.match(msg, /HTTPS_PROXY/);
});

// ─── describeNetworkError ───────────────────────────────────

test('describeNetworkError: ECONNRESET produces an actionable Chinese hint with proxy advice', () => {
  const msg = describeNetworkError(fetchFailure('ECONNRESET'));
  assert.match(msg, /ECONNRESET/);
  assert.match(msg, /HTTPS_PROXY/);
});

// ─── fetchWithRetry: the core #18 fix ───────────────────────

test('fetchWithRetry: retries a transient ECONNRESET and then succeeds (issue #18)', async () => {
  await withMockFetch(
    [
      () => Promise.reject(fetchFailure('ECONNRESET')),
      () => Promise.reject(fetchFailure('ECONNRESET')),
      () => Promise.resolve(okResponse('{"ok":true}')),
    ],
    async (calls) => {
      const res = await fetchWithRetry('https://example.com', { retries: 3, ...FAST });
      assert.equal(res.status, 200);
      assert.equal(calls.count, 3); // failed twice, succeeded on the third attempt
    },
  );
});

test('fetchWithRetry: exhausts retries then throws a described (not raw) error', async () => {
  await withMockFetch(
    [() => Promise.reject(fetchFailure('ECONNRESET'))],
    async (calls) => {
      await assert.rejects(
        () => fetchWithRetry('https://example.com', { retries: 2, ...FAST }),
        (err: Error) => {
          assert.match(err.message, /ECONNRESET/);
          assert.ok((err as { cause?: unknown }).cause, 'original error preserved as cause');
          // The rethrown error must still classify as retryable so pollLoop's diagnostic fires.
          assert.equal(isRetryableNetworkError(err), true);
          return true;
        },
      );
      assert.equal(calls.count, 3); // 1 initial + 2 retries
    },
  );
});

test('fetchWithRetry: does NOT retry a non-retryable error', async () => {
  await withMockFetch(
    [() => Promise.reject(new Error('boom'))],
    async (calls) => {
      await assert.rejects(() => fetchWithRetry('https://example.com', { retries: 3, ...FAST }));
      assert.equal(calls.count, 1); // tried exactly once
    },
  );
});

test('fetchWithRetry: returns 4xx without retrying (client errors are not transient)', async () => {
  await withMockFetch(
    [() => Promise.resolve(new Response('nope', { status: 404 }))],
    async (calls) => {
      const res = await fetchWithRetry('https://example.com', { retries: 3, retryOnHttpError: true, ...FAST });
      assert.equal(res.status, 404);
      assert.equal(calls.count, 1);
    },
  );
});

test('fetchWithRetry: retries 5xx only when retryOnHttpError is set', async () => {
  // Without the flag: a single 503 is returned as-is.
  await withMockFetch(
    [() => Promise.resolve(new Response('busy', { status: 503 }))],
    async (calls) => {
      const res = await fetchWithRetry('https://example.com', { retries: 3, ...FAST });
      assert.equal(res.status, 503);
      assert.equal(calls.count, 1);
    },
  );
  // With the flag: it retries, then succeeds.
  await withMockFetch(
    [
      () => Promise.resolve(new Response('busy', { status: 503 })),
      () => Promise.resolve(okResponse()),
    ],
    async (calls) => {
      const res = await fetchWithRetry('https://example.com', { retries: 3, retryOnHttpError: true, ...FAST });
      assert.equal(res.status, 200);
      assert.equal(calls.count, 2);
    },
  );
});

test('fetchWithRetry: an already-aborted external signal throws immediately without fetching', async () => {
  await withMockFetch(
    [() => Promise.resolve(okResponse())],
    async (calls) => {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        () => fetchWithRetry('https://example.com', { signal: ac.signal, retries: 3, ...FAST }),
        (err: Error) => err.name === 'AbortError',
      );
      assert.equal(calls.count, 0); // never even attempted
    },
  );
});

test('fetchWithRetry: external abort mid-flight is not retried', async () => {
  const ac = new AbortController();
  await withMockFetch(
    [
      () => {
        // Simulate the request being aborted by the caller (shutdown / cancel).
        ac.abort();
        return Promise.reject(Object.assign(new DOMException('Aborted', 'AbortError')));
      },
      () => Promise.resolve(okResponse()),
    ],
    async (calls) => {
      await assert.rejects(
        () => fetchWithRetry('https://example.com', { signal: ac.signal, retries: 3, ...FAST }),
        (err: Error) => err.name === 'AbortError',
      );
      assert.equal(calls.count, 1); // aborted → no retry
    },
  );
});
