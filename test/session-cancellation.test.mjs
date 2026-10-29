import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  AgentSessionRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import extension from '../index.js';
import { fetcher } from './helpers.mjs';

test('real Pi: a later extension cancelling a session replacement cannot leave a stale native override', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'free-cancel-'));
  const prior = process.env.PI_CODING_AGENT_DIR,
    original = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  const wires = [],
    errors = [];
  let session;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/chat/completions')) {
      wires.push(JSON.parse(init.body));
      return new Response(
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return fetcher()(url, init);
  };
  try {
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const cancel = (pi) =>
      pi.on('session_before_switch', () => ({ cancel: true }));
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [extension, cancel],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(dir),
    }));
    await session.bindExtensions({
      mode: 'print',
      onError: (e) => errors.push(e),
    });
    await session.setModel(
      session.modelRuntime.getModel('free-kilo', 'thinkingmachines/inkling-small:free'),
    );
    await session.prompt('/free-thinking high');
    const runtime = new AgentSessionRuntime(
      session,
      { cwd: dir, agentDir: dir },
      async () => {
        throw new Error(
          'Cancelled replacement must not create another runtime',
        );
      },
    );
    assert.equal((await runtime.newSession()).cancelled, true);
    assert.equal(runtime.session, session);
    session.setThinkingLevel('low');
    await session.prompt('17 * 19');
    assert.equal(wires.at(-1).reasoning?.effort, 'low');
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown' });
      session.dispose();
    }
    globalThis.fetch = original;
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
