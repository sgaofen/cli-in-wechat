import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFileName } from '../src/utils/media.js';

// A WeChat sender fully controls file_item.file_name and the image URL path.
// safeFileName must guarantee the result is a bare filename that cannot escape
// the media directory, regardless of input.

test('safeFileName: strips POSIX path traversal', () => {
  assert.equal(safeFileName('../../etc/passwd', 'file'), 'passwd');
  assert.equal(safeFileName('/etc/shadow', 'file'), 'shadow');
  assert.equal(safeFileName('a/b/c/report.pdf', 'file'), 'report.pdf');
});

test('safeFileName: strips Windows path traversal even on POSIX', () => {
  assert.equal(safeFileName('..\\..\\Windows\\system32\\evil.dll', 'file'), 'evil.dll');
  assert.equal(safeFileName('C:\\secrets\\key.txt', 'file'), 'key.txt');
});

test('safeFileName: bare ".." / "." fall back to a generated name (never traversal)', () => {
  const a = safeFileName('..', 'file');
  const b = safeFileName('.', 'image');
  assert.ok(!a.includes('..'));
  assert.match(a, /^file_/);
  assert.match(b, /^image_/);
});

test('safeFileName: leading dots are stripped (no hidden / dotfiles like .env, .ssh)', () => {
  assert.equal(safeFileName('.env', 'file'), 'env');
  assert.equal(safeFileName('...config', 'file'), 'config');
});

test('safeFileName: control chars and illegal chars are neutralized', () => {
  const out = safeFileName('a\x00b<c>d:e"f|g?h*i.txt', 'file');
  assert.ok(!/[\x00-\x1f<>:"/\\|?*]/.test(out));
  assert.match(out, /\.txt$/);
});

test('safeFileName: empty / undefined yields a typed generated name', () => {
  assert.match(safeFileName(undefined, 'video'), /^video_.*\.mp4$/);
  assert.match(safeFileName('', 'image'), /^image_.*\.jpg$/);
});

test('safeFileName: a normal name passes through unchanged', () => {
  assert.equal(safeFileName('photo_2024.png', 'image'), 'photo_2024.png');
  assert.equal(safeFileName('报告.pdf', 'file'), '报告.pdf');
});

test('safeFileName: overly long names are capped but keep the tail (extension)', () => {
  const long = 'x'.repeat(500) + '.zip';
  const out = safeFileName(long, 'file');
  assert.ok(out.length <= 200);
  assert.match(out, /\.zip$/);
});
