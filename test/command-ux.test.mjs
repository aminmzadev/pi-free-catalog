import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../index.js';
import { recordKey } from '../src/catalog.js';
import { COMMANDS } from '../src/command-help.js';
import { fixtures, fetcher } from './helpers.mjs';

async function environment(run, { selection } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'free-command-'));
  const prior = process.env.PI_CODING_AGENT_DIR,
    original = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  const commands = new Map(),
    events = new Map(),
    configs = new Map(),
    output = [];
  let fetches = 0,
    level = 'medium';
  const d = structuredClone(fixtures);
  globalThis.fetch = async (...args) => {
    fetches++;
    return fetcher(d)(...args);
  };
  const ctx = {
    hasUI: false,
    mode: 'print',
    model: undefined,
    ui: { setStatus() {}, setFooter() {} },
  };
  const pi = {
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerProvider: (name, config) => configs.set(name, config),
    sendMessage: (message) => output.push(message.content),
    getThinkingLevel: () => level,
    setThinkingLevel: (next) => {
      const previousLevel = level;
      level = next;
      if (next !== previousLevel)
        void events.get('thinking_level_select')?.(
          { level: next, previousLevel },
          ctx,
        );
    },
  };
  try {
    if (selection) {
      await mkdir(join(dir, 'free-catalog'));
      await writeFile(
        join(dir, 'free-catalog/thinking.json'),
        JSON.stringify(selection),
      );
    }
    await extension(pi);
    await run({
      dir,
      ctx,
      pi,
      commands,
      events,
      configs,
      output,
      data: d,
      get fetches() {
        return fetches;
      },
      setFetch: (fn) => {
        globalThis.fetch = fn;
      },
    });
  } finally {
    await events.get('session_shutdown')?.();
    globalThis.fetch = original;
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

test('exactly five stable commands use concise plain-English descriptions', async () =>
  environment(async (x) => {
    assert.deepEqual([...x.commands.keys()], Object.keys(COMMANDS));
    for (const [name, command] of x.commands) {
      assert.equal(command.description, COMMANDS[name].description);
      assert.ok(command.description.length <= 30);
      assert.doesNotMatch(command.description, /[\r\n\x1b]/);
    }
  }));

test('every --help works without a model, network, file writes, or thinking changes', async () =>
  environment(async (x) => {
    const folder = join(x.dir, 'free-catalog');
    const before = Object.fromEntries(
      await Promise.all(
        (await readdir(folder)).map(async (f) => [
          f,
          await readFile(join(folder, f), 'hex'),
        ]),
      ),
    );
    const fetches = x.fetches,
      thinking = x.pi.getThinkingLevel();
    for (const [name, command] of x.commands) {
      await command.handler('--help', x.ctx);
      assert.match(x.output.at(-1), new RegExp('/' + name));
    }
    const after = Object.fromEntries(
      await Promise.all(
        (await readdir(folder)).map(async (f) => [
          f,
          await readFile(join(folder, f), 'hex'),
        ]),
      ),
    );
    assert.deepEqual(after, before);
    assert.equal(x.fetches, fetches);
    assert.equal(x.pi.getThinkingLevel(), thinking);
  }));

test('unknown arguments to read/refresh show usage instead of causing side effects', async () =>
  environment(async (x) => {
    const fetches = x.fetches;
    await x.commands.get('free-refresh').handler('unexpected', x.ctx);
    assert.equal(x.fetches, fetches);
    assert.match(x.output.at(-1), /\/free-refresh/);
  }));

test('footer completion is useful and does not execute the command', async () =>
  environment(async (x) => {
    assert.deepEqual(
      x.commands
        .get('free-footer')
        .getArgumentCompletions('c')
        .map((x) => x.value),
      ['compact'],
    );
    assert.equal(
      x.commands.get('free-footer').getArgumentCompletions('invalid'),
      null,
    );
    assert.ok(
      x.commands
        .get('free-footer')
        .getArgumentCompletions('--')
        .some((x) => x.value === '--help'),
    );
    await assert.rejects(readFile(join(x.dir, 'free-catalog/ui.json')));
  }));

test('thinking completion follows current plain model identity and actual native choices', async () =>
  environment(async (x) => {
    const complete = () =>
      x.commands
        .get('free-thinking')
        .getArgumentCompletions('')
        .map((x) => x.value);
    assert.deepEqual(complete(), ['--help', 'auto', 'default']);
    x.ctx.model = { provider: 'free-kilo', id: 'poolside/laguna-s-2.1:free' };
    await x.events.get('model_select')({}, x.ctx);
    assert.deepEqual(complete(), [
      '--help',
      'auto',
      'default',
      'instant',
      'thinking',
    ]);
    assert.ok(!complete().includes('low'));
    x.ctx.model = { provider: 'anthropic', id: 'other' };
    await x.events.get('model_select')({}, x.ctx);
    assert.deepEqual(complete(), ['--help', 'auto', 'default']);
  }));

test('removed saved native mode remains inspectable with recovery instructions', async () =>
  environment(
    async (x) => {
      x.ctx.model = { provider: 'free-zen', id: 'beam-free' };
      await x.events.get('session_start')({}, x.ctx);
      await x.commands.get('free-thinking').handler('', x.ctx);
      const result = JSON.parse(x.output.at(-1));
      assert.equal(result.selected, 'removed-mode');
      assert.match(result.selectionError, /Unsupported/);
      assert.match(result.recovery, /\/free-thinking auto/);
      assert.ok(result.nativeChoices.low);
    },
    { selection: { [recordKey('zen', 'beam-free')]: 'removed-mode' } },
  ));

test('footer write failure applies runtime change and explicitly reports that it is unsaved', async () =>
  environment(async (x) => {
    await mkdir(join(x.dir, 'free-catalog/ui.json'));
    x.ctx.model = { provider: 'free-zen', id: 'beam-free' };
    await x.commands.get('free-footer').handler('compact', x.ctx);
    assert.match(x.output.at(-1), /Not saved:/);
    await x.commands.get('free-footer').handler('', x.ctx);
    assert.match(x.output.at(-1), /Footer: compact/);
  }));

test('thinking write failure is explicit, keeps the chosen runtime mode, and drains safely on shutdown', async () =>
  environment(async (x) => {
    await mkdir(join(x.dir, 'free-catalog/thinking.json'));
    x.ctx.model = { provider: 'free-zen', id: 'beam-free' };
    await x.events.get('session_start')({}, x.ctx);
    await x.commands.get('free-thinking').handler('high', x.ctx);
    assert.match(x.output.at(-1), /Not saved:/);
    assert.equal(x.pi.getThinkingLevel(), 'high');
    await x.commands.get('free-thinking').handler('', x.ctx);
    assert.equal(JSON.parse(x.output.at(-1)).selected, 'high');
  }));
