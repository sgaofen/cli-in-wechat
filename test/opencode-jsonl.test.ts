import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeJsonl } from '../src/adapters/opencode-jsonl.js';
import {
  OPEN_CODE_EVENTS,
  OPEN_CODE_JSONL,
  OPEN_CODE_ERROR_JSONL,
} from './fixtures/opencode-jsonl.js';

test('maps OpenCode text reasoning and terminal tool state in source order', () => {
  const activity: Array<{ type: string; content: string; toolName?: string }> = [];
  const parsed = parseOpenCodeJsonl(OPEN_CODE_JSONL, (message) => activity.push(message));

  assert.deepEqual(parsed, {
    text: '检查完成。',
    thinking: '先检查目录。',
    sessionId: 'ses_fixture',
    hasError: false,
  });
  assert.deepEqual(activity, [
    { type: 'thinking', content: '先检查目录。' },
    { type: 'tool_use', content: '- Shell Command: `npm test`', toolName: 'bash' },
    { type: 'tool_result', content: '  ↳ Exit: 0', toolName: 'bash' },
    { type: 'text', content: '检查完成。' },
  ]);
});

test('summarizes state.error when recognized and otherwise uses a fixed fallback', () => {
  const activity: Array<{ type: string; content: string; toolName?: string }> = [];
  const parsed = parseOpenCodeJsonl(OPEN_CODE_ERROR_JSONL, (message) => activity.push(message));

  assert.equal(parsed.hasError, true);
  assert.deepEqual(activity, [
    { type: 'tool_use', content: '- Shell Command: `exit 2`', toolName: 'bash' },
    { type: 'tool_result', content: '  ↳ Exit: 2', toolName: 'bash' },
    { type: 'tool_use', content: '- custom-tool', toolName: 'custom-tool' },
    { type: 'tool_result', content: '  ↳ Error', toolName: 'custom-tool' },
  ]);
});

test('accepts CRLF and a final JSON record without a trailing newline', () => {
  const jsonl = OPEN_CODE_EVENTS.map((event) => JSON.stringify(event)).join('\r\n');
  const parsed = parseOpenCodeJsonl(jsonl);
  assert.equal(parsed.text, '检查完成。');
  assert.equal(parsed.thinking, '先检查目录。');
  assert.equal(parsed.sessionId, 'ses_fixture');
});

test('ignores blank and malformed lines without losing later valid events', () => {
  const jsonl = [
    '',
    '{not-json',
    JSON.stringify({ type: 'text', sessionID: 'ses_after_bad', part: { text: '仍然有效' } }),
  ].join('\r\n');
  const parsed = parseOpenCodeJsonl(jsonl);
  assert.equal(parsed.text, '仍然有效');
  assert.equal(parsed.sessionId, 'ses_after_bad');
  assert.equal(parsed.hasError, false);
});

test('skips tool_use records with malformed part values and continues with later events', () => {
  const jsonl = [
    JSON.stringify({ type: 'tool_use' }),
    JSON.stringify({ type: 'tool_use', part: null }),
    JSON.stringify({ type: 'tool_use', part: 'not-an-object' }),
    JSON.stringify({ type: 'tool_use', part: [] }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_after_bad_part',
      part: {
        tool: 'bash',
        state: {
          input: { command: 'npm test' },
          output: 'Exit code 0',
        },
      },
    }),
    JSON.stringify({ type: 'text', part: { text: 'still valid' } }),
  ].join('\n');
  const activity: Array<{ type: string; content: string; toolName?: string }> = [];
  const parsed = parseOpenCodeJsonl(jsonl, (message) => activity.push(message));

  assert.equal(parsed.text, 'still valid');
  assert.equal(parsed.sessionId, 'ses_after_bad_part');
  assert.deepEqual(activity, [
    { type: 'tool_use', content: '- Shell Command: `npm test`', toolName: 'bash' },
    { type: 'tool_result', content: '  ↳ Exit: 0', toolName: 'bash' },
    { type: 'text', content: 'still valid' },
  ]);
});

test('does not invent de-duplication for repeated JSONL events', () => {
  const line = JSON.stringify({
    type: 'text',
    sessionID: 'ses_repeat',
    part: { type: 'text', text: 'same' },
  });
  const activity: Array<{ type: string; content: string }> = [];
  const parsed = parseOpenCodeJsonl(`${line}\n${line}`, (message) => activity.push(message));
  assert.equal(parsed.text, 'samesame');
  assert.deepEqual(activity, [
    { type: 'text', content: 'same' },
    { type: 'text', content: 'same' },
  ]);
});

test('keeps final text and thinking even when no callback is supplied', () => {
  const parsed = parseOpenCodeJsonl(OPEN_CODE_JSONL);
  assert.equal(parsed.text, '检查完成。');
  assert.equal(parsed.thinking, '先检查目录。');
});

test('preserves raw text whitespace in final aggregation but skips blank callbacks', () => {
  const jsonl = [
    JSON.stringify({ type: 'text', sessionID: 'ses_space', part: { text: '  answer  ' } }),
    JSON.stringify({ type: 'reasoning', part: { text: '\n thought \n' } }),
    JSON.stringify({ type: 'text', part: { text: '   ' } }),
  ].join('\n');
  const activity: Array<{ type: string; content: string }> = [];
  const parsed = parseOpenCodeJsonl(jsonl, (message) => activity.push(message));
  assert.equal(parsed.text, '  answer     ');
  assert.equal(parsed.thinking, '\n thought \n');
  assert.deepEqual(activity, [
    { type: 'text', content: '  answer  ' },
    { type: 'thinking', content: '\n thought \n' },
  ]);
});
