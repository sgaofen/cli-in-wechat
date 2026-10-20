import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { DEFAULT_SETTINGS, type UserSettings } from '../src/adapters/base.js';
import { ordinaryOpenCodeModels, flashEffortVariant } from '../src/adapters/opencode-models.js';

const flash = 'minimax/MiniMax-M3.1-Flash';
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
function catalog(model = flash, variants = Object.fromEntries(levels.map((level) => [level, { effort: level }]))) {
  return `${model}\n${JSON.stringify({ variants }, null, 2)}\nother/model\n{}\n`;
}

function mockCatalog(t: TestContext, output: string | Error) {
  t.mock.method(childProcess, 'execSync', (command: string, options: { cwd?: string }) => {
    assert.ok(['opencode models', 'opencode models --verbose'].includes(command));
    assert.equal(options.cwd, process.cwd());
    if (output instanceof Error) throw output;
    return output;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

// A real child process captures the owned CLI boundary without network or inference.
const fakeCLI = `
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  const emit = obj => console.log(JSON.stringify({ sessionID: 'existing-session', ...obj }));
  emit({ type: 'reasoning', part: { text: 'retained reasoning' } });
  emit({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed', input: { filePath: 'sample.txt' }, output: 'tool result' } } });
  emit({ type: 'text', part: { text: JSON.stringify({ argv: process.argv.slice(1), stdin }) } });
  emit({ type: 'step_finish', part: { reason: 'stop' } });
});`;

async function execute(settings: Partial<UserSettings> = {}, media = false) {
  const adapter = new OpenCodeAdapter((command, args, options) => {
    assert.equal(command, 'opencode');
    assert.equal(options.cwd, process.cwd());
    return spawn(process.execPath, ['--input-type=module', '-e', fakeCLI, '--', ...args], options);
  });
  const result = await adapter.execute('continue after the tool result', {
    settings: { ...DEFAULT_SETTINGS, sessionIds: { opencode: 'existing-session' }, ...settings },
    workDir: process.cwd(),
    timeout: 5000,
    extraArgs: ['--title', 'preserved title'],
    media: media ? [
      { type: 'image', path: join(process.cwd(), 'image.png'), fileName: 'image.png' },
      { type: 'video', path: join(process.cwd(), 'video.mp4'), fileName: 'video.mp4' },
      { type: 'file', path: join(process.cwd(), 'sample.txt'), fileName: 'sample.txt' },
    ] : undefined,
  });
  assert.equal(result.error, false);
  assert.equal(result.sessionId, 'existing-session');
  assert.equal(result.thinking, 'retained reasoning');
  const boundary = JSON.parse(result.text) as { argv: string[]; stdin: string };
  assert.equal(boundary.argv[boundary.argv.indexOf('-s') + 1], 'existing-session');
  assert.ok(boundary.argv.includes('--thinking'));
  assert.ok(boundary.argv.includes('preserved title'));
  return boundary;
}

test('ordinary choices rank available Flash before M3 and preserve custom/media routes', () => {
  const retained = ['other/model', 'custom/MiniMax-M2.7', 'minimax/speech-02-hd', 'minimax/video-01', 'minimax/my-custom-model'];
  assert.deepEqual(ordinaryOpenCodeModels([
    ...retained, 'minimax/MiniMax-M2.7', 'opencode/minimax-m2.5-free',
    'minimax/MiniMax-Text-01', 'openrouter/minimax/minimax-m1-80k',
    'openrouter/minimax/minimax-m2.5', 'minimax-cn/MiniMax-M3', 'openrouter/minimax/minimax-m3',
    'openrouter/minimax/minimax-m3.1-flash:free', flash, 'opencode/minimax-m3.1-flash-free',
  ]), [
    'openrouter/minimax/minimax-m3.1-flash:free', flash, 'opencode/minimax-m3.1-flash-free',
    'minimax-cn/MiniMax-M3', 'openrouter/minimax/minimax-m3', ...retained,
  ]);
  assert.deepEqual(ordinaryOpenCodeModels(['minimax/MiniMax-M2.7']), []);
});

test('Flash only accepts an effort advertised for the exact route', () => {
  for (const level of levels) assert.equal(flashEffortVariant(flash, level, catalog()), level);
  for (const level of ['none', 'disabled', 'invalid']) assert.equal(flashEffortVariant(flash, level, catalog()), undefined);
  assert.equal(flashEffortVariant(flash, 'low', catalog(flash, { thinking: {}, none: {} })), undefined);
  assert.equal(flashEffortVariant(flash, 'high', catalog('custom/model')), undefined);
  assert.equal(flashEffortVariant(flash, 'high', `${flash}\nnot json`), undefined);
});

for (const route of [flash, 'minimax-cn/MiniMax-M3.1-Flash', 'opencode/minimax-m3.1-flash-free', 'openrouter/minimax/minimax-m3.1-flash:free']) {
  test(`CLI boundary uses advertised Flash effort for ${route}`, async (t) => {
    mockCatalog(t, catalog(route));
    for (const effort of levels) {
      const { argv } = await execute({ model: route, effort });
      assert.equal(argv[argv.indexOf('-m') + 1], route);
      assert.equal(argv[argv.indexOf('--variant') + 1], effort);
      assert.ok(!argv.includes('none'));
    }
  });
}

for (const output of [catalog(flash, { thinking: {}, none: {} }), new Error('CLI catalog unavailable')]) {
  test('unsupported Flash effort preserves CLI defaults and media/history', async (t) => {
    mockCatalog(t, output);
    const { argv, stdin } = await execute({ model: flash, effort: 'low' }, true);
    assert.ok(!argv.includes('--variant'));
    for (const name of ['image.png', 'video.mp4', 'sample.txt', 'continue after the tool result']) assert.ok(stdin.includes(name));
  });
}

test('default, saved legacy, custom, unrelated and M3 selections cross the CLI boundary unchanged', async () => {
  for (const model of ['', 'minimax/MiniMax-M2.7', 'custom/MiniMax-M3.1-Flash', 'other/model', 'minimax/MiniMax-M3', 'minimax-cn/MiniMax-M3']) {
    const { argv } = await execute({ model, effort: 'low' });
    if (model) assert.equal(argv[argv.indexOf('-m') + 1], model);
    else assert.ok(!argv.includes('-m'));
    if (model.endsWith('/MiniMax-M3')) assert.equal(argv[argv.indexOf('--variant') + 1], 'none');
    else assert.ok(!argv.includes('--variant'));
  }
});

test('explicit bare legacy selection still resolves using the unfiltered catalog', async (t) => {
  mockCatalog(t, 'minimax/MiniMax-M2.7\n');
  const { argv } = await execute({ model: 'MiniMax-M2.7' });
  assert.equal(argv[argv.indexOf('-m') + 1], 'minimax/MiniMax-M2.7');
});
