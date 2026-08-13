import test from 'node:test';
import assert from 'node:assert/strict';

import { Router, createSendFileMarkerStripper } from '../src/bridge/router.js';
import { DeliveryFinalizationError } from '../src/ilink/client.js';
import { DEFAULT_SETTINGS } from '../src/adapters/base.js';
import type { BridgeConfig } from '../src/config.js';
import type { WeixinMessage } from '../src/ilink/types.js';

function createRouter() {
  const messages: Array<{ uid: string; text: string; options?: { priority?: string; generation?: number } }> = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const recoveries: string[] = [];
  const deliveryEvents: string[] = [];

  const ilink = {
    sendText: async (uid: string, text: string, options?: { priority?: string; generation?: number }) => {
      messages.push({ uid, text, options });
    },
    startTyping: async (uid: string) => {
      starts.push(uid);
      deliveryEvents.push(`start:${uid}`);
      return () => {
        stops.push(uid);
        deliveryEvents.push(`stop:${uid}`);
      };
    },
    recoverPending: async (uid: string) => {
      recoveries.push(uid);
      deliveryEvents.push(`recover:${uid}`);
      return [];
    },
    getDeliveryStatus: () => ({ quota: { generation: 1 }, pending: [], failed: [] }),
    onMessage: () => {},
  };

  const registry = {
    isAvailable: (name: string) => ['claude', 'codex', 'gemini'].includes(name),
    getNameByDisplayName: (displayName: string) => ({ Claude: 'claude', Codex: 'codex', Gemini: 'gemini' }[displayName]),
    getAvailableNames: () => ['claude', 'codex', 'gemini'],
    get: (name: string) => ({
      name,
      displayName: name === 'claude' ? 'Claude' : name === 'codex' ? 'Codex' : 'Gemini',
      capabilities: { sessionResume: false },
    }),
  };

  const state = new Map<string, { defaultTool?: string; sessionIds: Record<string, string> }>();
  const sessions = {
    get: (uid: string) => {
      if (!state.has(uid)) state.set(uid, { defaultTool: '', sessionIds: {} });
      return state.get(uid)!;
    },
    update: (uid: string, partial: { defaultTool?: string }) => Object.assign(sessions.get(uid), partial),
    setSession: () => {},
    clearSession: () => {},
  };

  const config: BridgeConfig = {
    defaultTool: 'gemini',
    maxResponseChunkSize: 2000,
    cliTimeout: 300_000,
    typingInterval: 5000,
    allowedUsers: [],
    allowAllUsers: true,
    workDir: process.cwd(),
    tools: {},
  };

  const router = new Router(ilink as any, registry as any, sessions as any, config);
  return {
    router: router as any,
    ilink: ilink as any,
    messages,
    starts,
    stops,
    recoveries,
    deliveryEvents,
    sessions,
  };
}

test('router denies users when neither a whitelist nor public opt-in is configured', async () => {
  const { router, messages } = createRouter();
  router.config.allowedUsers = [];
  router.config.allowAllUsers = false;

  await router.handle(makeMessage('stranger'), 'run command', '');

  assert.equal(messages.length, 0);
});

function makeMessage(uid: string): WeixinMessage {
  return {
    message_id: 1,
    from_user_id: uid,
    to_user_id: 'bot',
    client_id: 'client',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'ctx',
    item_list: [],
  };
}

test('default settings allow up to 100 turns', () => {
  assert.equal(DEFAULT_SETTINGS.maxTurns, 100);
});

test('/reset restores the independent 100-turn default', async () => {
  const { router, sessions } = createRouter();

  await router.handleSlash('u1', '/reset');

  assert.equal((sessions.get('u1') as any).maxTurns, 100);
});

test('getCli prefers @tool in text over quoted footer tool', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', '@codex explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'codex');
});

test('getCli fallback to refText if no @tool mention', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', 'explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'claude');
});

test('pending question resolution follows getCli-selected tool', async () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  let resolvedAnswer = '';
  router.pendingQuestions.set('u1:codex', {
    resolve: (answer: string) => {
      resolvedAnswer = answer;
    },
    timeout: setTimeout(() => {}, 1000),
    toolName: 'codex',
  });

  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '@codex 2', 'question body\n— Claude | 等待回复');

  assert.equal(resolvedAnswer, '@codex 2');
  assert.equal(execCalled, false);
  assert.equal(router.pendingQuestions.has('u1:codex'), false);
});

test('handle() rejects unknown @tool mention', async () => {
  const { router, messages } = createRouter();

  await router.handle(makeMessage('u1'), '@unknown hello', '');

  assert.ok(messages[0].text.includes('未知终端: @unknown'));
});

test('handle() combines prompt and refText with double newline', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', 'source code');

  assert.equal(capturedPrompt, 'explain\n\nsource code');
});

test('handle() omits refText in combined prompt if refText is empty', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', '');

  assert.equal(capturedPrompt, 'explain');
});

test('exact 继续 wraps pending outbox recovery with typing', async () => {
  const { router, ilink, starts, stops, recoveries, deliveryEvents } = createRouter();
  ilink.getDeliveryStatus = () => ({ quota: { generation: 1 }, pending: [{ itemId: 'pending-1' }], failed: [] });
  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '  继续  ', '');

  assert.deepEqual(recoveries, ['u1']);
  assert.deepEqual(starts, ['u1']);
  assert.deepEqual(stops, ['u1']);
  assert.deepEqual(deliveryEvents, ['start:u1', 'recover:u1', 'stop:u1']);
  assert.equal(execCalled, false);
});

test('exact 继续 with an empty outbox reaches the Agent as an ordinary prompt', async () => {
  const { router, starts, recoveries } = createRouter();
  let capturedPrompt = '';
  router.exec = async (_uid: string, _tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), '继续', '');

  assert.deepEqual(starts, []);
  assert.deepEqual(recoveries, ['u1']);
  assert.equal(capturedPrompt, '继续');
});

test('ordinary text still reaches the adapter after recovery is attempted', async () => {
  const { router, recoveries } = createRouter();
  let capturedPrompt = '';
  router.exec = async (_uid: string, _tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'new question', '');

  assert.deepEqual(recoveries, ['u1']);
  assert.equal(capturedPrompt, 'new question');
});

test('/status exposes the configured delivery window limit', async () => {
  const { router, messages } = createRouter();
  (router as any).ilink.getDeliveryStatus = () => ({
    quota: { sentItems: 2, remainingItems: 1, maxItemsPerWindow: 3, rateBackoffUntil: 0 },
    pending: [{ itemId: 'pending-1' }],
    failed: [{ itemId: 'failed-1' }],
  });

  await router.handleSlash('u1', '/status');

  assert.match(messages.at(-1)?.text || '', /delivery: pending=1 failed=1 sent=2\/3 remaining=1 ready/);
});

test('handleSlash /model strips accidental /. suffix from model name', async () => {
  const { router, sessions, messages } = createRouter();

  await router.handleSlash('u1', '/model glm-5/.');

  assert.equal((sessions.get('u1') as any).model, 'glm-5');
  assert.equal(messages[messages.length - 1]?.text, 'model → glm-5');
});

test('handleSlash /model 默认 resets model only', async () => {
  const { router, sessions, messages } = createRouter();
  sessions.update('u1', { model: 'glm-5', effort: 'low', mode: 'safe' } as any);

  await router.handleSlash('u1', '/model 默认');

  const settings = sessions.get('u1') as any;
  assert.equal(settings.model, '');
  assert.equal(settings.effort, 'low');
  assert.equal(settings.mode, 'safe');
  assert.equal(messages[messages.length - 1]?.text, 'model → 默认');
});

test('splitNormalActivityLines keeps single batch when within boundary', () => {
  const { router } = createRouter();
  const lines = [
    '- Skill: directory-list',
    '- Shell Command: dir "C:\\tmp\\demo"',
    '- Shell Command: ls -la',
  ];

  const batches = (router as any).splitNormalActivityLines(lines);

  assert.equal(Array.isArray(batches), true);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], lines);
});

test('splitNormalActivityLines splits oversized activity into multiple batches', () => {
  const { router } = createRouter();
  const lines = Array.from({ length: 18 }, (_, i) => `- Shell Command: very long command ${i + 1} ${'x'.repeat(80)}`);

  const batches = (router as any).splitNormalActivityLines(lines);

  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), lines);
  for (const batch of batches) {
    assert.ok(batch.length > 0);
  }
});

test('sendNormalActivityBatches waits 5 seconds between oversized batches', async () => {
  const { router, messages } = createRouter();
  const lines = Array.from({ length: 20 }, (_, i) => `- Shell Command: item ${i + 1} ${'y'.repeat(90)}`);
  const delays: number[] = [];
  (router as any).sleep = async (ms: number) => {
    delays.push(ms);
  };

  await (router as any).sendNormalActivityBatches('u1', lines);

  const activityMessages = messages.filter((m) => m.text.startsWith('Activity'));
  assert.ok(activityMessages.length > 1);
  assert.deepEqual(delays, Array(activityMessages.length - 1).fill(5000));
});

test('exec tags streamed answer text as intermediate and tool activity as activity', async () => {
  const { router, sessions, messages } = createRouter();
  sessions.update('u1', { msgMode: 'verbose' } as any);
  (router as any).registry.get = () => ({
    name: 'codex',
    displayName: 'Codex',
    capabilities: { sessionResume: false },
    execute: async (_prompt: string, options: any) => {
      options.onIntermediate({ type: 'text', content: 'answer progress' });
      options.onIntermediate({ type: 'tool_use', content: '- Shell Command: pwd' });
      return { text: 'answer progress', error: false };
    },
  });

  await router.exec('u1', 'codex', 'hello');

  assert.equal(messages.find((message) => message.text === 'answer progress')?.options?.priority, 'intermediate');
  assert.equal(messages.find((message) => message.text.startsWith('Activity'))?.options?.priority, 'activity');
  assert.equal(messages.at(-1)?.options?.priority, 'final');
});

test('compact normal and verbose preserve delivery content order and priorities', async (t) => {
  for (const mode of ['compact', 'normal', 'verbose'] as const) {
    await t.test(mode, async () => {
      const { router, sessions, messages } = createRouter();
      sessions.update('u1', { msgMode: mode } as any);
      (router as any).registry.get = () => ({
        name: 'codex',
        displayName: 'Codex',
        capabilities: { sessionResume: false },
        execute: async (_prompt: string, options: any) => {
          options.onIntermediate?.({ type: 'text', content: 'streamed answer' });
          options.onIntermediate?.({ type: 'tool_use', content: '- Shell Command: pwd' });
          return { text: 'streamed answer', duration: 1_000, error: false };
        },
      });

      await router.exec('u1', 'codex', 'hello', undefined, 7);

      assert.ok(messages.every((message) => message.options?.generation === 7));
      if (mode === 'compact') {
        assert.equal(messages.length, 1);
        assert.equal(messages[0].options?.priority, 'final');
        assert.match(messages[0].text, /^streamed answer/);
        assert.doesNotMatch(messages[0].text, /Activity|后续内容已排队/);
        return;
      }

      assert.equal(messages[0].text, 'streamed answer');
      assert.equal(messages[0].options?.priority, 'intermediate');
      if (mode === 'normal') {
        assert.equal(messages.length, 2);
        assert.equal(messages[1].options?.priority, 'final');
        assert.match(messages[1].text, /^Activity\n- Shell Command: pwd/);
        assert.doesNotMatch(messages[1].text, /streamed answer|后续内容已排队/);
        return;
      }

      assert.equal(messages.length, 3);
      assert.equal(messages[1].text, 'Activity\n- Shell Command: pwd');
      assert.equal(messages[1].options?.priority, 'activity');
      assert.equal(messages[2].options?.priority, 'final');
      assert.doesNotMatch(messages[2].text, /streamed answer|Activity|后续内容已排队/);
    });
  }
});

test('exec does not send a failure bubble after confirmed delivery bookkeeping fails', async () => {
  const { router, ilink } = createRouter();
  const attempts: string[] = [];
  ilink.sendText = async (_uid: string, text: string) => {
    attempts.push(text);
    if (attempts.length === 1) {
      throw new DeliveryFinalizationError('final-1', new Error('quota write failed'));
    }
  };
  (router as any).registry.get = () => ({
    name: 'codex',
    displayName: 'Codex',
    capabilities: { sessionResume: false },
    execute: async () => ({ text: 'already visible result', error: false }),
  });

  await router.exec('u1', 'codex', 'hello');

  assert.equal(attempts.length, 1);
  assert.doesNotMatch(attempts[0], /^失败:/);
});

test('chain does not send a failure bubble after confirmed delivery bookkeeping fails', async () => {
  const { router, ilink } = createRouter();
  const attempts: string[] = [];
  ilink.sendText = async (_uid: string, text: string) => {
    attempts.push(text);
    if (attempts.length === 1) {
      throw new DeliveryFinalizationError('chain-final-1', new Error('outbox ack failed'));
    }
  };
  (router as any).registry.get = (name: string) => ({
    name,
    displayName: name,
    capabilities: { sessionResume: false },
    execute: async () => ({ text: `${name} result`, error: false }),
  });

  await router.chain('u1', 'codex', 'gemini', 'hello');

  assert.equal(attempts.length, 1);
  assert.doesNotMatch(attempts[0], /^链式调用失败:/);
});

test('confirmed thinking bookkeeping failure does not suppress the final answer', async () => {
  const { router, ilink, sessions } = createRouter();
  sessions.update('u1', { msgMode: 'compact', showThoughts: true } as any);
  const attempts: string[] = [];
  ilink.sendText = async (_uid: string, text: string) => {
    attempts.push(text);
    if (attempts.length === 1) {
      throw new DeliveryFinalizationError('thinking-1', new Error('thinking ack failed'));
    }
  };
  (router as any).registry.get = () => ({
    name: 'codex',
    displayName: 'Codex',
    capabilities: { sessionResume: false },
    execute: async () => ({ text: 'actual final answer', thinking: 'visible thinking', error: false }),
  });

  await router.exec('u1', 'codex', 'hello');

  assert.equal(attempts.length, 2);
  assert.match(attempts[0], /visible thinking/);
  assert.match(attempts[1], /actual final answer/);
  assert.doesNotMatch(attempts[1], /^失败:/);
});

test('handle snapshots task generation before awaiting outbox recovery', async () => {
  const { router, ilink, messages } = createRouter();
  let generation = 1;
  let finishRecovery!: () => void;
  ilink.getDeliveryStatus = () => ({ quota: { generation } });
  ilink.recoverPending = () => new Promise<void>((resolve) => {
    finishRecovery = resolve;
  });
  (router as any).registry.get = () => ({
    name: 'codex',
    displayName: 'Codex',
    capabilities: { sessionResume: false },
    execute: async () => ({ text: 'older final', error: false }),
  });

  const handling = router.handle(makeMessage('u1'), '@codex older task', '');
  generation = 2;
  finishRecovery();
  await handling;

  assert.equal(messages.at(-1)?.options?.generation, 1);
});

test('exec sanitizes stale malformed model before adapter execution', async () => {
  const { router, sessions } = createRouter();
  const capturedModels: string[] = [];

  (router as any).registry.get = (_name: string) => ({
    name: 'opencode',
    displayName: 'OpenCode',
    capabilities: { sessionResume: false },
    execute: async (_prompt: string, opts: any) => {
      capturedModels.push(opts.settings.model);
      return { text: 'ok', error: false };
    },
  });

  sessions.update('u1', { model: 'glm-5/.' } as any);
  await router.exec('u1', 'opencode', 'hello');

  assert.equal(capturedModels[0], 'glm-5');
  assert.equal((sessions.get('u1') as any).model, 'glm-5');
});

test('exec maps stale default-alias model to empty before adapter execution', async () => {
  const { router, sessions } = createRouter();
  const capturedModels: string[] = [];

  (router as any).registry.get = (_name: string) => ({
    name: 'opencode',
    displayName: 'OpenCode',
    capabilities: { sessionResume: false },
    execute: async (_prompt: string, opts: any) => {
      capturedModels.push(opts.settings.model);
      return { text: 'ok', error: false };
    },
  });

  sessions.update('u1', { model: '默认/.' } as any);
  await router.exec('u1', 'opencode', 'hello');

  assert.equal(capturedModels[0], '');
  assert.equal((sessions.get('u1') as any).model, '');
});

// ─── Boolean-toggle confirmations must match the stored value (regression) ───
// Bug: update() mutates the live settings ref, so reading settings.<flag> after update()
// reported the inverted state. These assert the reply text matches what was actually stored.

for (const { cmd, field, on } of [
  { cmd: 'verbose', field: 'verbose', on: 'ON' },
  { cmd: 'search', field: 'search', on: 'ON' },
  { cmd: 'ephemeral', field: 'ephemeral', on: 'ON' },
  { cmd: 'thinking', field: 'thinking', on: 'ON (深度思考)' },
  { cmd: 'bare', field: 'bare', on: 'ON (跳过配置加载)' },
]) {
  test(`/${cmd} toggle reports the value it actually stored (on then off)`, async () => {
    const { router, sessions, messages } = createRouter();

    await router.handleSlash('u1', `/${cmd}`);
    assert.equal((sessions.get('u1') as any)[field], true, `${field} stored true`);
    assert.ok(messages[messages.length - 1].text.includes(on), `reply says ${on}`);

    await router.handleSlash('u1', `/${cmd}`);
    assert.equal((sessions.get('u1') as any)[field], false, `${field} stored false`);
    assert.ok(messages[messages.length - 1].text.includes('OFF'), 'reply says OFF');
  });
}

// ─── SEND_FILE marker stripping (streamed text) ───────────────────────────────
// These markers are injected into every prompt as a hint, so the model emits them
// routinely; anything that reaches WeChat verbatim is a visible bug.

test('stripper removes a marker from streamed text', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(strip('好的，发给你！\n\n[SEND_FILE: /tmp/report.pdf]'), '好的，发给你！');
});

test('stripper removes several markers in one chunk', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(
    strip('两个文件：[SEND_FILE: /tmp/a.pdf] 和 [SEND_FILE: /tmp/b.png]'),
    '两个文件： 和',
  );
});

test('stripper yields nothing for a marker-only chunk', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(strip('[SEND_FILE: /tmp/a.pdf]'), '');
});

test('stripper leaves ordinary bracketed text untouched', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(strip('见 [附件] 与 [1] 的说明'), '见 [附件] 与 [1] 的说明');
});

test('stripper rejoins a marker split across two chunks', () => {
  const strip = createSendFileMarkerStripper();
  // Neither half may reach the chat: the head is held back, the tail completes it.
  assert.equal(strip('给你：[SEND_FILE: /tmp/re'), '给你：');
  assert.equal(strip('port.pdf] 收好'), '收好');
});

test('stripper drops a marker head whose closing bracket never arrives', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(strip('结束了 [SEND_FILE: /tmp/re'), '结束了');
});

test('stripper stops buffering an unterminated head past the carry cap', () => {
  const strip = createSendFileMarkerStripper();
  assert.equal(strip(`[SEND_FILE: ${'x'.repeat(300)}`), '');
  // The head was too long to carry, so the next chunk stands on its own rather than
  // being swallowed into an ever-growing buffer.
  assert.equal(strip('正常文本'), '正常文本');
});
