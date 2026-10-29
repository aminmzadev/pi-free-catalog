// Copied into a clean customer directory so every bare import resolves ONLY its host install.
// Real Pi loader and production entrypoint; catalogs are intentionally mocked and inference is forbidden.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const installed = resolve(process.argv[2]);
const { snapshotFixture, pagesFetcher } = await import(pathToFileURL(join(installed, 'test/snapshot-helper.mjs')));
const delegate = pagesFetcher(await snapshotFixture()); let catalogs = 0; const errors = [];
globalThis.fetch = async (input, init) => {
  assert.notEqual((init?.method || 'GET').toUpperCase(), 'POST', 'No live inference in CI');
  catalogs++; return delegate(input, init);
};
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [join(installed, 'index.js')], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
try {
  await session.bindExtensions({ mode: 'print', uiContext: { setStatus() {}, notify() {} }, onError: e => errors.push(e) });
  const models = session.modelRuntime.getAllModels();
  for (const [provider, count] of [['free-kilo',17],['free-ovh',10]]) assert.equal(models.filter(m => m.provider === provider).length, count);
  assert.ok(!models.some(m => m.provider === 'free-zen'));
  assert.equal(catalogs, 1); assert.deepEqual(errors, []);
  console.log('Clean installed-artifact Pi loader: PASS; exactly two providers, no retired provider; one mocked Pages GET, no direct-source requests, zero inference.');
} finally { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
