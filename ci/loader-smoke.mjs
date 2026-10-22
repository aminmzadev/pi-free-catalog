// Copied into a clean customer directory so every bare import resolves ONLY its host install.
// Real Pi loader and production entrypoint; catalogs are intentionally mocked and inference is forbidden.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const installed = resolve(process.argv[2]);
const { fetcher } = await import(pathToFileURL(join(installed, 'test/helpers.mjs')));
const delegate = fetcher(); let catalogs = 0; const errors = [];
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
  for (const [provider, count] of [['free-kilo',17],['free-zen',10],['free-ovh',10]]) assert.equal(models.filter(m => m.provider === provider).length, count);
  assert.equal(models.find(m => m.provider === 'free-zen' && m.id === 'jev-1.13-free').type, 'classifier');
  assert.equal(catalogs, 7); assert.deepEqual(errors, []);
  console.log('Clean installed-artifact Pi loader: PASS; three providers and classifier; seven mocked GETs, zero inference.');
} finally { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
