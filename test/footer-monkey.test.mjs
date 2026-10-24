import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSeeds, configuredSteps, runFooterMonkey } from './footer-monkey-helper.mjs';
const seeds = configuredSeeds(), steps = configuredSteps();
for (const seed of seeds) test(`footer monkey seed=${seed} steps=${steps}`, async t => {
  const result = await runFooterMonkey(seed, steps);
  t.diagnostic(JSON.stringify(result));
});
test('footer monkey exact replay produces the same operation trace digest', async () => {
  const first = await runFooterMonkey(0, 180), second = await runFooterMonkey(0, 180);
  assert.equal(first.digest, second.digest); assert.deepEqual(first.coverage, second.coverage);
});

test('monkey failures save the seed, complete prefix trace and replay command; unwritable storage falls back to inline trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'footer-trace-'));
  try {
    await assert.rejects(runFooterMonkey(42, 10, { injectFailureAt: 3, failureDir: dir }), error => {
      assert.match(error.message, /Replay: FOOTER_MONKEY_SEED=42 FOOTER_MONKEY_STEPS=10/);
      assert.match(error.message, /footer-monkey-42-failure.json/); return true;
    });
    const saved = JSON.parse(await readFile(join(dir, 'footer-monkey-42-failure.json')));
    assert.equal(saved.seed, 42); assert.equal(saved.steps, 10); assert.equal(saved.trace.length, 4);
    assert.deepEqual(saved.trace.map(row => row.step), [0, 1, 2, 3]); assert.match(saved.error, /Injected/);
    const file = join(dir, 'not-a-directory'); await writeFile(file, 'blocked');
    await assert.rejects(runFooterMonkey(43, 10, { injectFailureAt: 0, failureDir: file }), error => {
      assert.match(error.message, /FOOTER_MONKEY_SEED=43/); assert.match(error.message, /Failure trace: \[\{"step":0,/); return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
