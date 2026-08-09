import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAllowedUsers, type BridgeConfig } from '../src/config.js';

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    defaultTool: 'claude',
    maxResponseChunkSize: 3_800,
    cliTimeout: 300_000,
    typingInterval: 5_000,
    allowedUsers: [],
    allowAllUsers: false,
    workDir: process.cwd(),
    tools: {},
    ...overrides,
  };
}

test('empty allowedUsers defaults to the authenticated owner', () => {
  assert.deepEqual(resolveAllowedUsers(config(), 'owner-user'), ['owner-user']);
});

test('public access requires an explicit allowAllUsers opt-in', () => {
  assert.deepEqual(resolveAllowedUsers(config({ allowAllUsers: true }), 'owner-user'), []);
  assert.deepEqual(resolveAllowedUsers(config({ allowedUsers: ['admin-user'] }), 'owner-user'), ['admin-user']);
});
