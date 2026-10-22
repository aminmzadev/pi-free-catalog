// Live test guard + evidence recorder. Never loaded by the production extension.
import {
  readFileSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
const root = process.env.AUDIT_ROOT,
  run = process.env.AUDIT_RUN_DIR;
if (!root || !run) throw new Error('Live test requires evidence directories');
mkdirSync(run, { recursive: true });
const snapshot = JSON.parse(
  readFileSync(join(root, 'live-catalog.json'), 'utf8'),
);
const allow = Object.values(snapshot.entries).filter(
  (e) =>
    e.listed &&
    e.fresh &&
    e.classification === 'free' &&
    e.lifecycle !== 'retired',
);
// Pi installs an HTTP dispatcher at startup; initialize it before instrumentation.
const { configureHttpDispatcher } = await import(
  process.env.PI_TEST_DISPATCHER
);
configureHttpDispatcher();
const original = globalThis.fetch;
let n = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url,
  );
  const method = (
    init.method || (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  let body;
  try {
    body = JSON.parse(
      typeof init.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : '{}',
    );
  } catch {}
  const service =
    url.hostname === 'api.kilo.ai'
      ? 'kilo'
      : url.hostname === 'opencode.ai'
        ? 'zen'
        : null;
  const headers = new Headers(
    init.headers || (input instanceof Request ? input.headers : undefined),
  );
  const info = {
    at: new Date().toISOString(),
    method,
    url: url.href,
    model: body?.model,
    authorization_header_present: headers.has('authorization'),
    personal_key:
      headers.has('authorization') &&
      headers.get('authorization') !== 'Bearer public',
    tools: (body?.tools || []).map((t) => t.function?.name || t.name),
    reasoning: body?.reasoning,
    reasoning_effort: body?.reasoning_effort,
    userAgent: headers.get('user-agent'),
  };
  const post = method === 'POST';
  const id = ++n;
  if (post) {
    const ledger = join(
      root,
      `${service || 'unrelated'}-inference-ledger.jsonl`,
    );
    const count = existsSync(ledger)
      ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    if (
      !allow.some((e) => e.service === service && e.id === body?.model) ||
      count >= 120 ||
      info.personal_key
    ) {
      info.blocked = 'free-only/auth/budget guard';
      info.status = 499;
      appendFileSync(join(run, 'wire.jsonl'), JSON.stringify(info) + '\n');
      return Response.json(
        { error: { message: info.blocked } },
        { status: 499 },
      );
    }
    appendFileSync(ledger, JSON.stringify(info) + '\n');
    writeFileSync(
      join(run, `request-${id}.json`),
      JSON.stringify({ url: url.href, method, body }, null, 2),
    );
  }
  try {
    const response = await original(input, init);
    info.status = response.status;
    info.retryAfter = response.headers.get('retry-after');
    appendFileSync(join(run, 'wire.jsonl'), JSON.stringify(info) + '\n');
    if (post && !response.ok)
      writeFileSync(
        join(run, `response-error-${id}.txt`),
        (await response.clone().text()).slice(0, 64000),
      );
    return response;
  } catch (e) {
    info.error = String(e);
    appendFileSync(join(run, 'wire.jsonl'), JSON.stringify(info) + '\n');
    throw e;
  }
};
