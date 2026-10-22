import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessToolWorkflow,
  assertModelCompleted,
} from '../scripts/live-checks.mjs';

function sample() {
  const cwd = '/evidence',
    dir = '/evidence/free-kilo-tools',
    sha = 'verified-hash',
    token = 'random-token';
  const names = ['read', 'write', 'edit', 'bash'];
  const events = names.flatMap((toolName, i) => [
    {
      type: 'tool_execution_start',
      toolName,
      toolCallId: String(i),
      args:
        toolName === 'bash'
          ? { command: 'python3 /evidence/free-kilo-tools/verify.py' }
          : {
              path: `free-kilo-tools/${toolName === 'read' ? 'fixture' : 'result'}.txt`,
            },
    },
    {
      type: 'tool_execution_end',
      toolName,
      toolCallId: String(i),
      isError: false,
      result: { text: sha },
    },
  ]);
  return {
    cwd,
    dir,
    sha,
    token,
    events,
    data: 'verified-file',
    expected: 'verified-file',
    answer: `DONE ${token} ${sha}`,
    last: { stopReason: 'stop' },
    fixtureUnchanged: true,
    verifierUnchanged: true,
  };
}

test('successful ordered real-tool evidence and final completion pass, including relative tool paths', () =>
  assert.equal(assessToolWorkflow(sample()).pass, true));
for (const stopReason of ['error', 'aborted', 'toolUse', 'length', undefined]) {
  test(`correct files/text cannot hide unsuccessful final state: ${stopReason}`, () => {
    const x = sample();
    x.last = {
      stopReason,
      errorMessage:
        stopReason === 'error' ? 'stream failed after correct text' : undefined,
    };
    assert.equal(assessToolWorkflow(x).pass, false);
  });
}
for (const field of [
  'data',
  'answer',
  'fixtureUnchanged',
  'verifierUnchanged',
]) {
  test(`tool acceptance rejects damaged evidence: ${field}`, () => {
    const x = sample();
    x[field] = typeof x[field] === 'boolean' ? false : 'wrong';
    assert.equal(assessToolWorkflow(x).pass, false);
  });
}
test('having all four tool names is insufficient when order is wrong', () => {
  const x = sample();
  x.events = [
    ...x.events.slice(2, 4),
    ...x.events.slice(0, 2),
    ...x.events.slice(4),
  ];
  assert.equal(assessToolWorkflow(x).ordered, false);
  assert.equal(assessToolWorkflow(x).pass, false);
});
test('extra legitimate repair calls do not cause an exactly-four-calls false failure', () => {
  const x = sample();
  x.events.push(
    ...structuredClone(x.events).map((e) => ({
      ...e,
      toolCallId: 'repair-' + e.toolCallId,
    })),
  );
  assert.equal(assessToolWorkflow(x).pass, true);
});
test('a failed tool is not counted as a successful tool', () => {
  const x = sample();
  x.events.find(
    (e) => e.type === 'tool_execution_end' && e.toolName === 'edit',
  ).isError = true;
  assert.equal(assessToolWorkflow(x).pass, false);
});
test('model errors and cancellation enforce fail-fast; successful final messages do not throw', () => {
  assert.throws(
    () =>
      assertModelCompleted({ stopReason: 'error', errorMessage: 'blocked' }),
    /stopped/,
  );
  assert.throws(
    () => assertModelCompleted({ stopReason: 'aborted' }),
    /stopped/,
  );
  assert.doesNotThrow(() => assertModelCompleted({ stopReason: 'stop' }));
});
