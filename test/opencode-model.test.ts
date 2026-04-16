import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBareModelFromList } from '../src/adapters/opencode.js';

test('resolveBareModelFromList keeps provider/model as-is', () => {
  const model = resolveBareModelFromList('baiduqianfancodingplan/glm-5', [
    'baiduqianfancodingplan/glm-5',
  ]);
  assert.equal(model, 'baiduqianfancodingplan/glm-5');
});

test('resolveBareModelFromList resolves bare model by unique suffix match', () => {
  const model = resolveBareModelFromList('glm-5', [
    'opencode/gpt-5-nano',
    'baiduqianfancodingplan/glm-5',
  ]);
  assert.equal(model, 'baiduqianfancodingplan/glm-5');
});

test('resolveBareModelFromList keeps bare model when no suffix match', () => {
  const model = resolveBareModelFromList('glm-5', [
    'opencode/gpt-5-nano',
    'opencode/big-pickle',
  ]);
  assert.equal(model, 'glm-5');
});

test('resolveBareModelFromList prefers baiduqianfancodingplan when ambiguous', () => {
  const model = resolveBareModelFromList('glm-5', [
    'someprovider/glm-5',
    'baiduqianfancodingplan/glm-5',
  ]);
  assert.equal(model, 'baiduqianfancodingplan/glm-5');
});

test('resolveBareModelFromList strips trailing slash', () => {
  const model = resolveBareModelFromList('minimax-m2.5-free/', []);
  assert.equal(model, 'minimax-m2.5-free');
});

test('resolveBareModelFromList strips multiple trailing slashes', () => {
  const model = resolveBareModelFromList('glm-5///', []);
  assert.equal(model, 'glm-5');
});

test('resolveBareModelFromList resolves bare model after stripping trailing slash', () => {
  const model = resolveBareModelFromList('glm-5/', [
    'opencode/gpt-5-nano',
    'baiduqianfancodingplan/glm-5',
  ]);
  assert.equal(model, 'baiduqianfancodingplan/glm-5');
});
