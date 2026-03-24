import test from 'node:test';
import assert from 'node:assert/strict';

import { Router } from '../src/bridge/router.js';
import type { BridgeConfig } from '../src/config.js';
import type { WeixinMessage } from '../src/ilink/types.js';

function createRouter() {
  const messages: Array<{ uid: string; text: string }> = [];
  const starts: string[] = [];

  const ilink = {
    sendText: async (uid: string, text: string) => {
      messages.push({ uid, text });
    },
    startTyping: async (uid: string) => {
      starts.push(uid);
      return () => {};
    },
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
    workDir: process.cwd(),
    tools: {},
  };

  const router = new Router(ilink as any, registry as any, sessions as any, config);
  return { router: router as any, messages, starts, sessions };
}

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
