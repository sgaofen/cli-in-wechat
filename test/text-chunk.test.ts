import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkUtf8Text } from '../src/ilink/text-chunk.js';

test('chunkUtf8Text preserves Unicode while respecting the byte limit', () => {
  const input = '你好🙂\n```ts\nconst value = "保留";\n```';
  const chunks = chunkUtf8Text(input, 12);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 12));
  assert.deepEqual(Array.from(chunks.join('')), Array.from(input));
});

test('chunkUtf8Text never emits empty chunks and rejects invalid limits', () => {
  assert.deepEqual(chunkUtf8Text('abc', 10), ['abc']);
  assert.ok(chunkUtf8Text('a🙂b', 4).every(Boolean));
  assert.throws(() => chunkUtf8Text('x', 0), /positive/);
});
