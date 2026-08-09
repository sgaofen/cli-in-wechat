import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyApiFailure,
  type ApiErrorDetails,
  type SendResult,
} from '../src/ilink/send-result.js';

test('classifyApiFailure uses ret=-2 as an ambiguous scheduler backoff signal', () => {
  const error: ApiErrorDetails = { ret: -2, errcode: 17, errmsg: 'rate limited' };
  assert.deepEqual(classifyApiFailure(error), {
    status: 'rate-limited',
    ambiguous: true,
    error,
  });
});

test('classifyApiFailure preserves non-rate API errors and does not trust errmsg alone', () => {
  assert.deepEqual(classifyApiFailure({ ret: 0, errmsg: 'rate limited' }), null);
  assert.deepEqual(classifyApiFailure({ ret: 9, errcode: 4, errmsg: 'bad token' }), {
    status: 'permanent-failure',
    ambiguous: false,
    error: { ret: 9, errcode: 4, errmsg: 'bad token' },
  });
});

test('classifyApiFailure treats deterministic HTTP 4xx responses as permanent', () => {
  for (const httpStatus of [400, 401, 403, 413]) {
    const error = { httpStatus, errmsg: `HTTP ${httpStatus}` };
    assert.deepEqual(classifyApiFailure(error), {
      status: 'permanent-failure',
      ambiguous: false,
      error,
    });
  }
});

test('classifyApiFailure keeps timeout and overload HTTP responses retryable', () => {
  assert.equal(classifyApiFailure({ httpStatus: 408 })?.status, 'ambiguous');
  assert.equal(classifyApiFailure({ httpStatus: 429 })?.status, 'rate-limited');
  assert.equal(classifyApiFailure({ httpStatus: 503 })?.status, 'ambiguous');
});

test('SendResult exposes the durable item identity and generation metadata', () => {
  const result: SendResult = {
    status: 'queued',
    itemId: 'item-1',
    userId: 'user-1',
    generation: 3,
    tokenVersion: 2,
    attemptedBytes: 15,
  };
  assert.equal(result.itemId, 'item-1');
  assert.equal(result.generation, 3);
});
