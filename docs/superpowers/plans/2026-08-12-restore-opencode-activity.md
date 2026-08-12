# Restore Historical OpenCode Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faithfully restore the OpenCode `text`, `reasoning`, `tool_use`, and curated `tool_result` activity behavior that existed in commit `2e94a7c`, without replacing the CLI transport or changing current final response, session resume, model, Router, or delivery behavior.

**Architecture:** Keep `opencode run --format json --thinking` and the current `spawnCli`/`collectUtf8` close-time collection path. Move Claude's existing tool summarizers to `base.ts` unchanged so Claude and OpenCode share the historical presentation contract, parse the completed OpenCode JSONL with one small pure function, and have `OpenCodeAdapter` pass mapped events to the existing `onIntermediate` callback only outside compact mode. This restores the historical activity contract but deliberately does not add low-latency stdout streaming; `capabilities.streaming = true` retains the historical meaning that the adapter can produce intermediate messages, even though this CLI path emits them while processing stdout after process close.

**Tech Stack:** TypeScript, Node.js built-in test runner, OpenCode CLI `1.18.16` JSONL, existing adapter `IntermediateMessage` contract, existing Router message-mode handling.

---

## Scope And File Map

Historical source of truth:

- `2e94a7c` is the behavior specification. Restore its shared Claude/OpenCode summary helpers and OpenCode event mapping by semantics, not by cherry-picking the old commit.
- Locally installed OpenCode `1.18.16` documents `run --format json` as raw JSON events. Existing audit evidence records complete `text`/`reasoning` parts and terminal `tool_use` records whose `part.state` carries `input` plus `output` or `error` in the same JSON object.
- Archived SDK commits `ec177d8` and `a422764` are explicitly excluded. Do not import an OpenCode SDK, add a server, or add CLI-to-SDK fallback.

Files to create or modify:

- Create `test/fixtures/opencode-jsonl.ts`: synthetic, credential-free OpenCode `1.18.16` JSONL fixtures representing the locally audited schema; no real Agent request is run to produce them.
- Create `src/adapters/opencode-jsonl.ts`: pure close-time JSONL-to-result/activity mapper; it does not spawn a process, buffer byte chunks, or know message modes.
- Create `test/opencode-jsonl.test.ts`: parser contract tests for event order, terminal tool records, malformed lines, CRLF, final unterminated lines, errors, and deliberate non-deduplication.
- Create `test/opencode-adapter.test.ts`: no-network fake-child integration tests that exercise `OpenCodeAdapter.execute()` through its real argv/stdin/close-time path, including normal callbacks and adapter-level compact gating.
- Modify `test/base-helpers.test.ts`: lock the existing Claude tool-summary presentation before moving it.
- Modify `src/adapters/base.ts`: export the existing Claude summary helpers with no output changes.
- Modify `src/adapters/claude.ts`: import those helpers; all SDK/CLI execution and activity semantics remain unchanged.
- Modify `test/opencode-model.test.ts`: lock `OpenCodeAdapter.capabilities.streaming` as `true` while retaining current model and MiniMax behavior.
- Modify `src/adapters/opencode.ts`: add only an injectable `spawnCli` seam with the current function as its constructor default, call the pure mapper after `collectUtf8` completes, gate callbacks only by compact mode, and preserve current command arguments, final fallback, session, thinking, error, model, media, abort, and stdin behavior.

Files that must not change:

- `src/bridge/router.ts` and `test/router.test.ts`: compact/normal/verbose rendering, text de-duplication, durable delivery, and activity batching already exist and are covered.
- `src/ilink/**`: Issue #26 delivery behavior is unrelated to this restoration.
- Package dependencies and lockfiles: the CLI and Node standard library are sufficient.

The parser consumes a complete UTF-8 string after process close. Therefore byte-split safety remains the responsibility of the already-tested `collectUtf8`; no second `StringDecoder`, chunk buffer, line-size policy, or live stdout parser is introduced here. A future low-latency transport enhancement, if separately requested, must be a distinct change with timing/backpressure tests and must not be represented by this restoration.

### Task 1: Lock And Extract The Historical Shared Tool Summaries

**Files:**
- Modify: `test/base-helpers.test.ts`
- Modify: `src/adapters/base.ts`
- Modify: `src/adapters/claude.ts`

- [ ] **Step 1: Add failing public-contract tests for the shared summaries**

Extend the import in `test/base-helpers.test.ts` and append these exact tests:

```ts
import {
  collectUtf8,
  writeStdin,
  buildMediaPrompt,
  killProc,
  summarizeToolUse,
  summarizeToolResult,
} from '../src/adapters/base.js';

test('summarizeToolUse preserves the historical Claude/OpenCode activity labels', () => {
  assert.equal(
    summarizeToolUse('bash', { command: 'npm   test' }),
    '- Shell Command: `npm test`',
  );
  assert.equal(
    summarizeToolUse('read', { file_path: 'C:\\repo\\src\\index.ts' }),
    '- Read File: `index.ts`',
  );
  assert.equal(
    summarizeToolUse('websearch', { query: 'OpenCode JSONL events' }),
    '- WebSearch: `OpenCode JSONL events`',
  );
  assert.equal(summarizeToolUse('unknown-tool', {}), '- unknown-tool');
});

test('summarizeToolResult emits only the historical curated result summaries', () => {
  assert.equal(summarizeToolResult('bash', 'Exit code 0\nhello'), '  ↳ Exit: 0');
  assert.equal(summarizeToolResult('webfetch', 'HTTP: 404'), '  ↳ HTTP: 404');
  assert.equal(summarizeToolResult('read', 'secret file contents'), '');
  assert.equal(summarizeToolResult('unknown-tool', 'large noisy output'), '');
});
```

Do not change any existing helper tests.

- [ ] **Step 2: Run the helper tests and observe RED**

Run: `node --import tsx --test test/base-helpers.test.ts`

Expected: FAIL at module load because `base.ts` does not export `summarizeToolUse` or `summarizeToolResult`.

- [ ] **Step 3: Move the exact helper implementation without changing behavior**

Delete the six local helper functions at the top of `src/adapters/claude.ts` and append this exact implementation to `src/adapters/base.ts`:

```ts
export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.substring(0, maxLen)}...` : text;
}

export function basenameFromPath(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathLike;
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = ['text', 'output', 'result', 'content', 'message'];
    for (const key of preferred) {
      if (key in obj) {
        const text = asString(obj[key]);
        if (text) return text;
      }
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function pickStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = asString(obj[key]).trim();
    if (value) return value;
  }
  return '';
}

export function summarizeToolUse(toolName: string, input: unknown): string {
  const t = toolName || 'Tool';
  const obj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};

  if (/^bash$/i.test(t)) {
    const cmd = pickStringField(obj, ['command', 'cmd', 'script']);
    return cmd
      ? `- Shell Command: \`${truncate(cmd.replace(/\s+/g, ' ').trim(), 120)}\``
      : '- Shell Command';
  }

  if (/^read$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Read File: \`${basenameFromPath(path)}\``
      : '- Read File';
  }

  if (/^skill$/i.test(t)) {
    const skill = pickStringField(obj, ['skill', 'name', 'skillName']);
    return skill
      ? `- Skill: \`${basenameFromPath(skill)}\``
      : '- Skill';
  }

  if (/^glob$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'glob']);
    return pattern
      ? `- Glob: \`${truncate(pattern, 80)}\``
      : '- Glob';
  }

  if (/^grep$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'query', 'regex']);
    return pattern
      ? `- Grep: \`${truncate(pattern, 80)}\``
      : '- Grep';
  }

  if (/^ls$/i.test(t)) {
    const path = pickStringField(obj, ['path', 'directory']);
    return path
      ? `- LS: \`${truncate(path, 80)}\``
      : '- LS';
  }

  if (/^edit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Edit File: \`${basenameFromPath(path)}\``
      : '- Edit File';
  }

  if (/^write$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Write File: \`${basenameFromPath(path)}\``
      : '- Write File';
  }

  if (/^multiedit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- MultiEdit: \`${basenameFromPath(path)}\``
      : '- MultiEdit';
  }

  if (/^notebookread$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookRead: \`${basenameFromPath(path)}\``
      : '- NotebookRead';
  }

  if (/^notebookedit$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookEdit: \`${basenameFromPath(path)}\``
      : '- NotebookEdit';
  }

  if (/^webfetch$/i.test(t)) {
    const url = pickStringField(obj, ['url', 'uri']);
    return url
      ? `- WebFetch: \`${truncate(url, 120)}\``
      : '- WebFetch';
  }

  if (/^websearch$/i.test(t)) {
    const query = pickStringField(obj, ['query', 'q', 'searchQuery']);
    return query
      ? `- WebSearch: \`${truncate(query, 100)}\``
      : '- WebSearch';
  }

  if (/^(task|agent)$/i.test(t)) {
    const sub = pickStringField(obj, ['agent', 'agent_type', 'subagent_type', 'name']);
    const prompt = pickStringField(obj, ['description', 'prompt', 'task', 'instruction']);
    if (sub && prompt) return `- ${t}: \`${sub}\` — ${truncate(prompt, 80)}`;
    if (sub) return `- ${t}: \`${sub}\``;
    if (prompt) return `- ${t}: ${truncate(prompt, 80)}`;
    return `- ${t}`;
  }

  if (/^todowrite$/i.test(t)) {
    return '- TodoWrite';
  }

  return `- ${t}`;
}

export function summarizeToolResult(toolName: string | undefined, content: unknown): string {
  const text = asString(content).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const tool = (toolName || '').toLowerCase();
  if (tool === 'bash') {
    const exit = text.match(/Exit code\s+(-?\d+)/i);
    if (exit) return `  ↳ Exit: ${exit[1]}`;
    if (/\bno output\b/i.test(text)) return '  ↳ Exit: no output';
    return '';
  }

  if (tool === 'skill') {
    const m = text.match(/Launching skill:\s*([^\s]+)/i);
    if (m) return `  ↳ Launch: \`${m[1]}\``;
    return '';
  }

  if (tool === 'webfetch') {
    const status = text.match(/\b(?:HTTP|Status)\s*[: ]\s*(\d{3})/i);
    if (status) return `  ↳ HTTP: ${status[1]}`;
    return '';
  }

  if (tool === 'websearch') {
    const n = text.match(/(\d+)\s+(?:result|results|条)/i);
    if (n) return `  ↳ Results: ${n[1]}`;
    return '';
  }

  if (tool === 'agent' || tool === 'task') {
    if (/completed with no output/i.test(text)) return '  ↳ Completed';
    if (/error/i.test(text)) return '  ↳ Error';
    return '';
  }

  if (tool === 'read') {
    return '';
  }

  // Default: do not dump raw result excerpts to avoid noisy/low-value spam.
  return '';
}
```

This is the complete current Claude implementation. Do not reformat or otherwise change these bodies during extraction.

Replace the two current `claude.ts` imports with:

```ts
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import {
  commandExists,
  spawnCli,
  setupAbort,
  setupTimeout,
  isSessionError,
  buildMediaPrompt,
  collectUtf8,
  writeStdin,
  summarizeToolUse,
  summarizeToolResult,
} from './base.js';
```

Delete only the six now-shared local helper declarations from `claude.ts`. Do not edit `ClaudeAdapter`, its SDK path, CLI fallback, pending tool association, or callback code.

- [ ] **Step 4: Run focused tests and type checking**

Run: `node --import tsx --test test/base-helpers.test.ts test/router.test.ts`

Expected: all helper and Router tests PASS; the existing Claude-compatible activity strings remain unchanged.

Run: `npm run typecheck`

Expected: PASS with no duplicate declaration or import errors.

- [ ] **Step 5: Commit the helper extraction**

```powershell
git add docs/superpowers/plans/2026-08-12-restore-opencode-activity.md src/adapters/base.ts src/adapters/claude.ts test/base-helpers.test.ts
git commit -m "refactor: share adapter tool activity summaries"
```

Expected: one behavior-preserving code commit that also records the reviewed implementation plan; `git diff HEAD^ -- src/adapters/claude.ts` shows helper deletion/import changes only.

### Task 2: Lock The OpenCode 1.18 JSONL Activity Contract

**Files:**
- Create: `test/fixtures/opencode-jsonl.ts`
- Create: `test/opencode-jsonl.test.ts`

- [ ] **Step 1: Add credential-free fixtures for the audited CLI schema**

Create `test/fixtures/opencode-jsonl.ts` with complete JSON records generated from plain objects so quoting and CRLF transformations stay deterministic:

```ts
const sessionID = 'ses_fixture';

export const OPEN_CODE_EVENTS = [
  {
    type: 'step_start',
    sessionID,
    part: { type: 'step-start' },
  },
  {
    type: 'reasoning',
    sessionID,
    part: { type: 'reasoning', text: '先检查目录。' },
  },
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_shell_ok',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm   test' },
        output: 'Exit code 0\nall tests passed',
      },
    },
  },
  {
    type: 'text',
    sessionID,
    part: { type: 'text', text: '检查完成。' },
  },
  {
    type: 'step_finish',
    sessionID,
    part: { type: 'step-finish', reason: 'stop' },
  },
] as const;

export const OPEN_CODE_JSONL = OPEN_CODE_EVENTS.map((event) => JSON.stringify(event)).join('\n');

export const OPEN_CODE_ERROR_JSONL = [
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_shell_error',
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'exit 2' },
        error: 'Exit code 2\nPermission denied',
      },
    },
  },
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_custom_error',
      tool: 'custom-tool',
      state: {
        status: 'error',
        input: { target: 'fixture' },
        error: 'Unrecognized private failure detail',
      },
    },
  },
  {
    type: 'step_finish',
    sessionID,
    part: { type: 'step-finish', reason: 'error' },
  },
].map((event) => JSON.stringify(event)).join('\n');
```

These are schema fixtures, not claims of a live captured run. Do not run `opencode run`, contact an Agent, or place account, prompt, path, session, or model data from the user's machine into fixtures.

- [ ] **Step 2: Add RED tests for ordered text, reasoning, and terminal tool mapping**

Create `test/opencode-jsonl.test.ts`:

```ts
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
```

Normal outputs preserve the historical privacy/noise rule: a `tool_result` is emitted only when the shared summarizer has a curated summary. Handling structured `state.error` is one deliberate minimal compatibility difference from `2e94a7c`, which only read `state.output`: pass the error through `summarizeToolResult(toolName, error)` first, and emit the fixed `  ↳ Error` fallback only when that shared summarizer returns empty. The difference is required by the locally audited OpenCode `1.18.16` terminal `tool_use` schema, where a failed tool places its error in the same record's `part.state.error`. The two fixture records verify both the safe curated result and the redacted fallback without forwarding unrecognized raw error details to WeChat.

- [ ] **Step 3: Add RED boundary tests appropriate to close-time parsing**

Append these tests to `test/opencode-jsonl.test.ts`:

```ts
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
```

The repeated-record test deliberately matches `2e94a7c`: the adapter preserves the CLI event sequence and does not infer call lifecycle or deduplicate by `callID`. Router already prevents one streamed answer from being resent again as a final body; that is a separate, existing de-duplication behavior covered in `test/router.test.ts`.

Do not add byte-chunk tests here. `parseOpenCodeJsonl` accepts a completed string; `test/base-helpers.test.ts` already verifies that `collectUtf8` preserves a Chinese character split across stdout buffer boundaries. The CRLF/final-line tests are the relevant line-boundary coverage for this scope.

- [ ] **Step 4: Run the new parser tests and observe RED**

Run: `node --import tsx --test test/opencode-jsonl.test.ts test/base-helpers.test.ts`

Expected: FAIL because `src/adapters/opencode-jsonl.ts` does not exist. The existing `collectUtf8` multibyte split test still passes.

### Task 3: Implement The Minimal Close-Time JSONL Mapper

**Files:**
- Create: `src/adapters/opencode-jsonl.ts`
- Test: `test/opencode-jsonl.test.ts`

- [ ] **Step 1: Add the pure result type and safe record helpers**

Create `src/adapters/opencode-jsonl.ts` with these definitions:

```ts
import type { IntermediateMessage } from './base.js';
import { summarizeToolResult, summarizeToolUse } from './base.js';

export interface ParsedOpenCodeJsonl {
  text: string;
  thinking: string;
  sessionId?: string;
  hasError: boolean;
}

type IntermediateSink = (message: IntermediateMessage) => void;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}
```

- [ ] **Step 2: Implement one-pass parsing and historical event mapping**

Append the complete mapper:

```ts
export function parseOpenCodeJsonl(
  stdout: string,
  onIntermediate?: IntermediateSink,
): ParsedOpenCodeJsonl {
  let text = '';
  let thinking = '';
  let sessionId: string | undefined;
  let hasError = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }

    const type = nonEmptyString(event.type);
    const part = record(event.part);
    const partText = typeof part.text === 'string' ? part.text : '';

    if (!sessionId) {
      sessionId = nonEmptyString(event.sessionID) || undefined;
    }

    if (type === 'text' && partText) {
      text += partText;
      if (partText.trim()) {
        onIntermediate?.({ type: 'text', content: partText });
      }
    } else if (type === 'reasoning' && partText) {
      thinking += partText;
      if (partText.trim()) {
        onIntermediate?.({ type: 'thinking', content: partText });
      }
    } else if (type === 'tool_use') {
      const toolName = nonEmptyString(part.tool) || 'Tool';
      const state = record(part.state);
      onIntermediate?.({
        type: 'tool_use',
        content: summarizeToolUse(toolName, state.input),
        toolName,
      });

      const error = nonEmptyString(state.error);
      const output = state.output;
      const summary = error
        ? summarizeToolResult(toolName, error) || '  ↳ Error'
        : summarizeToolResult(toolName, output);
      if (summary) {
        onIntermediate?.({ type: 'tool_result', content: summary, toolName });
      }
    }

    if (type === 'step_finish' && part.reason === 'error') {
      hasError = true;
    }
  }

  return { text, thinking, sessionId, hasError };
}
```

Do not add `callID` tracking, pending maps, SDK types, incremental byte decoding, raw-output forwarding, logging, callback-exception isolation, or message-mode checks. The terminal OpenCode record already contains its input and result state. Raw text/reasoning strings, including leading and trailing whitespace, are always retained in final aggregation as in the current adapter and `2e94a7c`; only whitespace-only intermediate callbacks are skipped.

- [ ] **Step 3: Run the parser and helper suites to GREEN**

Run: `node --import tsx --test test/opencode-jsonl.test.ts test/base-helpers.test.ts`

Expected: all tests PASS, including CRLF, malformed-line continuation, error redaction, deliberate repeat preservation, final output, and the existing split UTF-8 byte test.

- [ ] **Step 4: Commit the fixture and pure mapper**

```powershell
git add src/adapters/opencode-jsonl.ts test/opencode-jsonl.test.ts test/fixtures/opencode-jsonl.ts
git commit -m "test: lock historical opencode activity mapping"
```

Expected: a self-contained parser commit with no process, Router, iLink, dependency, or SDK changes.

### Task 4: Restore OpenCode Adapter Activity Without Regressing Current Features

**Files:**
- Create: `test/opencode-adapter.test.ts`
- Modify: `test/opencode-model.test.ts`
- Modify: `src/adapters/opencode.ts`
- Test: `test/opencode-jsonl.test.ts`
- Test: `test/router.test.ts`

- [ ] **Step 1: Add a fake-child integration test that cannot reach the real CLI**

Create `test/opencode-adapter.test.ts` with this complete code:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage } from '../src/adapters/base.js';
import { OpenCodeAdapter, type OpenCodeSpawn } from '../src/adapters/opencode.js';

interface SpawnCapture {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
  stdin: string;
}

const ADAPTER_JSONL = [
  {
    type: 'reasoning',
    sessionID: 'ses_adapter',
    part: { type: 'reasoning', text: ' reason ' },
  },
  {
    type: 'tool_use',
    sessionID: 'ses_adapter',
    part: {
      type: 'tool',
      callID: 'call_adapter',
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'exit 2' },
        error: 'Exit code 2\nfixture failure must stay private',
      },
    },
  },
  {
    type: 'tool_use',
    sessionID: 'ses_adapter',
    part: {
      type: 'tool',
      callID: 'call_adapter_fallback',
      tool: 'custom-tool',
      state: {
        status: 'error',
        input: { target: 'fixture' },
        error: 'unrecognized fixture failure must stay private',
      },
    },
  },
  {
    type: 'text',
    sessionID: 'ses_adapter',
    part: { type: 'text', text: ' final answer ' },
  },
  {
    type: 'step_finish',
    sessionID: 'ses_adapter',
    part: { type: 'step-finish', reason: 'error' },
  },
].map((event) => JSON.stringify(event)).join('\r\n');

function createFakeSpawn(stdoutText: string, closeCode = 0): {
  spawn: OpenCodeSpawn;
  capture: SpawnCapture;
} {
  const capture: SpawnCapture = { stdin: '' };
  const spawn: OpenCodeSpawn = (command, args, options) => {
    capture.command = command;
    capture.args = [...args];
    capture.options = options;

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { capture.stdin += chunk; });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      exitCode: null,
      pid: 4242,
      kill: () => true,
    });

    queueMicrotask(() => {
      stdout.end(stdoutText);
      stderr.end();
      Object.assign(child, { exitCode: closeCode });
      child.emit('close', closeCode, null);
    });
    return child;
  };
  return { spawn, capture };
}

function settings(msgMode: 'normal' | 'compact') {
  return {
    ...DEFAULT_SETTINGS,
    mode: 'auto' as const,
    model: 'minimax/MiniMax-M3',
    effort: 'high',
    workDir: 'C:\\fixture-work',
    sessionIds: { opencode: 'ses_resume' },
    msgMode,
  };
}

test('OpenCode execute maps activity and preserves current argv stdin and final result', async () => {
  const fake = createFakeSpawn(ADAPTER_JSONL);
  const activity: IntermediateMessage[] = [];
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('  prompt unchanged  ', {
    settings: settings('normal'),
    extraArgs: ['--fixture-extra'],
    onIntermediate: (message) => activity.push(message),
  });

  assert.equal(fake.capture.command, 'opencode');
  assert.deepEqual(fake.capture.args, [
    'run', '--format', 'json', '--thinking',
    '--dir', 'C:\\fixture-work',
    '--auto',
    '-m', 'minimax/MiniMax-M3',
    '--variant', 'thinking',
    '-s', 'ses_resume',
    '--fixture-extra',
  ]);
  assert.equal(fake.capture.options?.cwd, 'C:\\fixture-work');
  assert.equal(fake.capture.stdin, '  prompt unchanged  ');
  assert.deepEqual(result, {
    text: ' final answer ',
    thinking: ' reason ',
    sessionId: 'ses_adapter',
    error: true,
  });
  assert.deepEqual(activity, [
    { type: 'thinking', content: ' reason ' },
    { type: 'tool_use', content: '- Shell Command: `exit 2`', toolName: 'bash' },
    { type: 'tool_result', content: '  ↳ Exit: 2', toolName: 'bash' },
    { type: 'tool_use', content: '- custom-tool', toolName: 'custom-tool' },
    { type: 'tool_result', content: '  ↳ Error', toolName: 'custom-tool' },
    { type: 'text', content: ' final answer ' },
  ]);
});

test('OpenCode execute gates callbacks in compact mode but preserves the final result', async () => {
  const fake = createFakeSpawn(ADAPTER_JSONL);
  const activity: IntermediateMessage[] = [];
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('compact prompt', {
    settings: settings('compact'),
    onIntermediate: (message) => activity.push(message),
  });

  assert.deepEqual(activity, []);
  assert.deepEqual(result, {
    text: ' final answer ',
    thinking: ' reason ',
    sessionId: 'ses_adapter',
    error: true,
  });
});

test('OpenCode execute folds a nonzero process exit into the parsed result', async () => {
  const successJsonl = JSON.stringify({
    type: 'text',
    sessionID: 'ses_process_error',
    part: { type: 'text', text: 'partial answer' },
  });
  const fake = createFakeSpawn(successJsonl, 7);
  const adapter = new OpenCodeAdapter(fake.spawn);

  const result = await adapter.execute('process error prompt', {
    settings: settings('compact'),
  });

  assert.deepEqual(result, {
    text: 'partial answer',
    thinking: undefined,
    sessionId: 'ses_process_error',
    error: true,
  });
});
```

The fake spawn function returns only in-memory Node streams and schedules fixture output; it never resolves or invokes the `opencode` executable. The provider-qualified model bypasses `opencode models`, so the test has no secondary CLI path. The first test covers `normal` adapter callbacks, both `state.error` branches (curated Bash `Exit code 2` and fixed fallback for an unrecognized custom-tool error), step error mapping, final raw whitespace, first session ID, resume, `--auto`, MiniMax `--variant`, extra arguments, cwd, and exact stdin. The second test locates compact gating at `OpenCodeAdapter.execute()` while proving that gating does not remove the final parsed result. The third test independently covers nonzero process-exit error folding.

- [ ] **Step 2: Compile the test to observe a safe RED before a spawn seam exists**

Run:

```powershell
npx tsc --noEmit --target ES2022 --module Node16 --moduleResolution Node16 --strict --esModuleInterop --skipLibCheck test/opencode-adapter.test.ts
```

Expected: FAIL because `OpenCodeSpawn` is not exported and `OpenCodeAdapter` does not accept the fake spawn dependency. Do not run this test with `node --test` yet: JavaScript would ignore the extra constructor argument and could launch the real CLI.

- [ ] **Step 3: Add only the injectable spawn seam**

In `src/adapters/opencode.ts`, immediately above the class, add:

```ts
export type OpenCodeSpawn = typeof spawnCli;
```

At the top of `OpenCodeAdapter`, before `isAvailable`, add:

```ts
constructor(private readonly spawnOpenCode: OpenCodeSpawn = spawnCli) {}
```

Replace only the production spawn call:

```ts
const proc = this.spawnOpenCode(this.command, args, {
  cwd: settings.workDir || opts.workDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});
```

Run the same `npx tsc ... test/opencode-adapter.test.ts` command.

Expected: PASS. The default constructor remains production-compatible and still calls the existing `spawnCli`; no registry or caller changes are required.

- [ ] **Step 4: Run the fake-child test and observe behavioral RED**

Run: `node --import tsx --test test/opencode-adapter.test.ts`

Expected: FAIL because the current close-time loop returns the final fields but never calls `onIntermediate`. In the normal-mode test, actual activity is `[]` while expected activity includes both the curated Bash error result `  ↳ Exit: 2` and the unrecognized custom-tool fallback `  ↳ Error`; compact remains empty, proving the fake is used without touching the real CLI.

- [ ] **Step 5: Add the historical capability assertion and observe RED**

Append to `test/opencode-model.test.ts`:

```ts
test('OpenCode advertises intermediate activity support', () => {
  assert.equal(new OpenCodeAdapter().capabilities.streaming, true);
});
```

Run: `node --import tsx --test test/opencode-model.test.ts`

Expected: FAIL because the current adapter declares `streaming: false`.

- [ ] **Step 6: Import the mapper and restore the capability flag**

At the top of `src/adapters/opencode.ts`, add:

```ts
import { parseOpenCodeJsonl } from './opencode-jsonl.js';
```

Change only the capability value:

```ts
readonly capabilities: AdapterCapabilities = {
  streaming: true, jsonOutput: true, sessionResume: true,
  modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: false,
};
```

Keep `hasEffort: true`, MiniMax variants, `--auto`, direct Windows spawn handling, media prompt handling, model resolution, session resume, and every other current field unchanged. `streaming: true` means the historical callback capability; it does not claim stdout-timing guarantees.

- [ ] **Step 7: Replace only the close-time JSON loop with the pure mapper**

Inside the existing `proc.on('close', ...)` handler, after obtaining `stdout` and `stderr`, replace the current JSONL loop with:

```ts
try {
  const onIntermediate = settings.msgMode !== 'compact'
    ? opts.onIntermediate
    : undefined;
  const parsed = parseOpenCodeJsonl(stdout, onIntermediate);
  const hasError = code !== 0 || parsed.hasError;

  log.debug(`[opencode] final thinking length: ${parsed.thinking.length}`);
  if (parsed.text) {
    resolve({
      text: parsed.text,
      thinking: parsed.thinking || undefined,
      sessionId: parsed.sessionId,
      error: hasError,
    });
  } else {
    resolve({
      text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`,
      error: code !== 0,
    });
  }
} catch {
  resolve({
    text: stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`,
    error: code !== 0,
  });
}
```

Retain the current abort branch before parsing and the current process `error` handler after it. Do not move parsing to `proc.stdout.on('data')`; callbacks intentionally retain `2e94a7c` close-time timing. Do not add a message-mode branch inside the parser: compact gating remains an adapter/Router concern.

- [ ] **Step 8: Run focused adapter and Router regression tests**

Run: `node --import tsx --test test/opencode-adapter.test.ts test/opencode-jsonl.test.ts test/opencode-model.test.ts test/base-helpers.test.ts test/router.test.ts`

Expected: all tests PASS. In particular:

- OpenCode retains `hasEffort: true`, current model alias cleanup, and MiniMax thinking variants.
- Parsed final `text`, `thinking`, first `sessionID`, and step/process error state are preserved.
- Both `state.error` paths are GREEN through the real adapter: Bash `Exit code 2` becomes curated `  ↳ Exit: 2`, while an unrecognized custom-tool error becomes fixed `  ↳ Error` without exposing raw details.
- Compact mode receives no adapter callback because `onIntermediate` is omitted.
- Existing Router tests continue to prove text is not duplicated in the final body, normal mode collects tool activity, verbose mode sends activity in order, and compact mode sends only final content.

- [ ] **Step 9: Inspect the semantic diff against both the base and history**

Run:

```powershell
git diff 332345a...HEAD -- docs/superpowers/plans/2026-08-12-restore-opencode-activity.md src/adapters/base.ts src/adapters/claude.ts src/adapters/opencode.ts src/adapters/opencode-jsonl.ts test/base-helpers.test.ts test/opencode-adapter.test.ts test/opencode-model.test.ts test/opencode-jsonl.test.ts test/fixtures/opencode-jsonl.ts
git show --stat --oneline 2e94a7c
git diff 2e94a7c^ 2e94a7c -- src/adapters/base.ts src/adapters/claude.ts src/adapters/opencode.ts
```

Expected: the current diff restores the three historical semantic units (shared summaries, event mapping, capability flag), while retaining all post-history OpenCode CLI/process/model/session changes. There are no edits to Router, iLink, dependencies, or archived SDK code.

- [ ] **Step 10: Commit the adapter integration**

```powershell
git add src/adapters/opencode.ts test/opencode-adapter.test.ts test/opencode-model.test.ts
git commit -m "fix: restore opencode activity callbacks"
```

Expected: the branch contains three small commits: helper extraction, parser/fixtures, adapter integration.

### Task 5: Review The Open PR Stack, Then Rebase And Re-review After PR #29 Merges

**Files:**
- Review only: restoration commits above PR #29 head `332345a` while PR #29 is open; after it merges, review the rebased restoration commits above the new `upstream/main`.
- Do not create an upstream restoration PR from the open-PR stack. PR creation is gated on PR #29 merging, a rebase onto latest `upstream/main`, full verification, and a second specification-plus-quality review of the rebased head.

- [ ] **Step 1: Verify the open-PR stack has the exact reviewed PR #29 base**

Run:

```powershell
git fetch --all --prune
$expectedStackBase = git rev-parse 332345a
$pullRequest = gh pr view 29 --repo sgaofen/cli-in-wechat --json state,headRefOid,url | ConvertFrom-Json
if ($pullRequest.state -ne 'OPEN') { throw "PR #29 is not open; use the post-merge path" }
if ($pullRequest.headRefOid -ne $expectedStackBase) { throw "PR #29 head moved: $($pullRequest.headRefOid)" }
$actualStackBase = git merge-base HEAD $expectedStackBase
if ($actualStackBase -ne $expectedStackBase) { throw "restoration is not stacked on PR #29 head" }
git diff --stat 332345a...HEAD
git diff --name-only 332345a...HEAD
```

Expected: both `git rev-parse` and `git merge-base` resolve to full commit `332345a...`, proving that restoration is stacked directly on the reviewed PR #29 head. The triple-dot provenance diff contains only this plan, shared summary extraction, the OpenCode JSONL mapper/fixtures, fake-child adapter test, capability test, and minimal adapter integration. It contains no Issue #26 changes because those are in the base.

- [ ] **Step 2: Run complete verification on the open-PR stack**

```powershell
npm test
npm run typecheck
npm run build
git diff --check 332345a...HEAD
```

Expected: full tests PASS with only the existing platform skips, typecheck PASS, build PASS, and diff-check emits no whitespace errors. Record exact pass/skip/fail counts rather than copying a historical count.

- [ ] **Step 3: Run the open-stack specification review before quality review**

Dispatch a fresh specification-review agent with base `332345a`, the exact current head SHA, and this checklist:

```text
Review only git diff 332345a...HEAD for conformance to the restoration plan and
commit 2e94a7c semantics. Require: unchanged shared Claude summaries; OpenCode
raw text/reasoning aggregation; nonblank intermediate mapping; terminal tool_use
input plus curated state.output; the explicit OpenCode 1.18.16 state.error
compatibility difference that tries summarizeToolResult(toolName, error) first and
uses fixed `  ↳ Error` only when no curated summary exists; callback order; streaming capability true;
compact gating in OpenCodeAdapter; fake-child proof of final text/thinking/session/error,
resume, --auto, MiniMax args, cwd, extra args, and stdin preservation.
Exclude: Router/iLink changes, SDK commits ec177d8/a422764, live stdout redesign,
callback-exception isolation, new dependencies, and real Agent execution.
Report findings with file/line evidence and severity. Do not edit code.
```

Expected: PASS with no unmet requirement. For any finding, use a fresh implementation agent, add a RED regression test first where applicable, make the minimum correction, rerun focused and full verification, and repeat this specification review against `332345a...<new-head>` until PASS.

- [ ] **Step 4: Run open-stack code-quality review only after specification PASS**

Dispatch a different fresh reviewer with base `332345a`, the exact spec-passed head, and this checklist:

```text
Review implementation quality and regression risk in git diff 332345a...HEAD.
Check unsafe unknown casts, raw whitespace preservation, malformed JSON isolation,
CRLF/final-line handling, privacy of tool outputs/errors, event order, deliberate
no-dedup policy, historical callback propagation, close/error/abort behavior,
minimality of the spawn seam, fake-child determinism, helper extraction drift,
test realism, and scope creep. Verify no credentials/private evidence are tracked
and no SDK/dependency was introduced.
Report findings with file/line evidence and severity. Do not edit code.
```

Expected: PASS with no actionable finding. For any fix, change the head through a fresh fix agent, rerun all verification, and repeat both open-stack reviews because their reviewed head is stale.

- [ ] **Step 5: Wait for PR #29 to merge; do not open the restoration PR while it is pending**

Read PR #29 state without modifying it. If it remains open, report the reviewed stacked head to the coordinating agent and stop before external PR creation. Once PR #29 is merged, run:

```powershell
gh pr view 29 --repo sgaofen/cli-in-wechat --json state,mergedAt,mergeCommit,url
git fetch upstream --prune
$mergedBase = git rev-parse upstream/main
git rebase --onto $mergedBase 332345a
git merge-base --is-ancestor $mergedBase HEAD
```

Expected: `gh` reports `state: MERGED` with non-null `mergedAt`/`mergeCommit`; `upstream/main` is fetched after that observation; the rebase replays only commits after old stack base `332345a` onto latest upstream; and the final ancestry command exits 0. This also works if GitHub used a squash merge and `332345a` itself is not an ancestor of upstream. Never cherry-pick `ec177d8` or `a422764`. If conflicts touch `base.ts`, `claude.ts`, `opencode.ts`, or tests, preserve merged upstream behavior and replay only reviewed restoration semantics.

- [ ] **Step 6: Rerun full verification after the post-merge rebase**

Run:

```powershell
$mergedBase = git merge-base HEAD upstream/main
npm test
npm run typecheck
npm run build
git diff --check $mergedBase...HEAD
```

Expected: full tests, typecheck, and build PASS again on the rebased commit identities; diff-check emits no errors. This verification cannot be reused from the open-PR stack.

- [ ] **Step 7: Repeat specification review on the rebased head**

Dispatch a fresh specification reviewer with exact `$mergedBase` and head SHAs. Use the Step 3 checklist, replacing `332345a...HEAD` with `$mergedBase...HEAD`, and additionally require that upstream PR #29 behavior is absent from the diff because it is now in the base.

Expected: PASS. Any fix invalidates this review; reproduce with RED where applicable, fix minimally, rerun Step 6, then repeat this specification review.

- [ ] **Step 8: Repeat quality review after the rebased specification PASS**

Dispatch a different fresh quality reviewer with exact `$mergedBase` and spec-passed head SHAs. Use the Step 4 checklist, replacing `332345a...HEAD` with `$mergedBase...HEAD`.

Expected: PASS. Any head change requires Step 6 plus both post-merge reviews again. The earlier open-stack reviews are evidence only and do not satisfy this gate.

- [ ] **Step 9: Perform final provenance and cleanliness checks**

Run:

```powershell
git status --short --branch
git log --oneline --decorate upstream/main..HEAD
git diff --stat upstream/main...HEAD
git diff --name-only upstream/main...HEAD
$allowed = @(
  'docs/superpowers/plans/2026-08-12-restore-opencode-activity.md',
  'src/adapters/base.ts',
  'src/adapters/claude.ts',
  'src/adapters/opencode-jsonl.ts',
  'src/adapters/opencode.ts',
  'test/base-helpers.test.ts',
  'test/fixtures/opencode-jsonl.ts',
  'test/opencode-adapter.test.ts',
  'test/opencode-jsonl.test.ts',
  'test/opencode-model.test.ts'
)
$changed = @(git diff --name-only upstream/main...HEAD)
$unexpected = @($changed | Where-Object { $_ -notin $allowed })
if ($unexpected.Count -ne 0) { throw "unexpected upstream diff: $($unexpected -join ', ')" }
$sdkCommits = @('ec177d8', 'a422764')
foreach ($sdkCommit in $sdkCommits) {
  git merge-base --is-ancestor $sdkCommit HEAD
  if ($LASTEXITCODE -eq 0) { throw "excluded SDK commit is an ancestor: $sdkCommit" }
}
```

Expected: the worktree is clean; `upstream/main...HEAD` contains only the allowlisted restoration files and no Issue #26 diff; both SDK ancestry checks exit non-zero without triggering the explicit throw; semantic review confirms no SDK implementation was copied wholesale; no Router, iLink, private evidence, log, outbox snapshot, credential, package, or lockfile changes appear.

- [ ] **Step 10: Hand the twice-reviewed branch back to the coordinating agent**

Report:

```text
- open-stack base 332345a, pre-merge reviewed head, merged upstream base SHA, and post-rebase reviewed head SHA
- exact commits and changed files
- focused and full verification results
- pre-merge and post-rebase spec-review PASS and quality-review PASS, including reviewer identities
- exact semantic comparison with 2e94a7c
- explicit statement: close-time activity restored; live stdout transport not implemented
- explicit statement: ec177d8/a422764 excluded and no real Agent request run
- proof PR #29 is merged and upstream/main...HEAD contains only restoration work
- whether the branch is ready for an upstream restoration PR
```

Do not push, force-push, or open a PR unless the coordinating agent separately authorizes that external action after reviewing the report.

## Self-Review Record

- Spec coverage: every requested historical unit is assigned to a RED test and minimal implementation task. A no-network fake child drives the real `OpenCodeAdapter.execute()` path and covers normal callbacks, compact gating, final raw text/thinking/session/error, resume, `--auto`, MiniMax variant, extra arguments, cwd, stdin, and nonzero exit behavior. Current Claude, Router, `/models`, `maxTurns`, delivery, and unrelated CLI behavior remain explicit non-goals or regression checks.
- Transport decision: mandatory restoration uses complete-stdout close-time parsing because that is what `2e94a7c` implemented. UTF-8 byte splitting remains covered by `collectUtf8`; half-line/CRLF/malformed/error/repeated/final-output behavior is covered at the parser boundary. Low-latency stdout parsing is expressly deferred.
- Compatibility decision: handling `state.error` is the only deliberate event-mapping difference from `2e94a7c`: call `summarizeToolResult(toolName, error)` first, then use fixed `  ↳ Error` only when no curated summary exists. Both the curated Bash error and unrecognized-error fallback are tested against the locally audited OpenCode `1.18.16` terminal `tool_use` schema; callback-exception isolation was removed as unrelated hardening.
- Stack lifecycle: while PR #29 is open, exact head `332345a` is asserted and `332345a...HEAD` receives full verification plus specification and quality review. After merge, restoration-only commits are rebased onto latest `upstream/main`, then full verification and both reviews are repeated before any upstream restoration PR.
- Placeholder scan: no incomplete-marker keywords or deferred implementation steps remain; every code-producing step includes exact interfaces, code, commands, and expected results.
- Type consistency: `parseOpenCodeJsonl(stdout, onIntermediate?)` returns `{ text, thinking, sessionId?, hasError }`; `OpenCodeSpawn` is exactly `typeof spawnCli`; the constructor defaults to production `spawnCli`; fixtures, fake-child tests, and adapter integration use those exact types; callbacks use the existing `IntermediateMessage` type.
- Scope check: this plan restores one adapter behavior. Durable task handoff, media persistence, Router lifecycle, and SDK transport are independent milestones and are not bundled here.
