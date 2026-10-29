import { applyThinking, selectThinking } from './models.js';

export const PACKAGE_VERSION = '0.1.8';
import { OVH_BASE } from './ovh.js';

export function anonymousHeaders(service) {
  if (service === 'ovh') return { 'User-Agent': `pi-free-catalog/${PACKAGE_VERSION}` };
  if (service !== 'kilo') throw new Error('Unknown anonymous provider');
  return { 'x-kilo-free': 'true', 'User-Agent': `pi-free-catalog/${PACKAGE_VERSION}` };
}
/** Scoped fetch only; no monkey-patching global fetch/http, no credentials read. */
export function scopedFetch({
  catalog,
  service,
  model,
  getFetch = () => globalThis.fetch,
  onResponse,
  onWait,
  pacing,
}) {
  return async (input, init = {}) => {
    if (!['kilo', 'ovh'].includes(service)) throw new Error('Unknown anonymous provider');
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url,
    );
    const method = (
      init.method || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const prefix =
      service === 'ovh' ? OVH_BASE + '/' : 'https://api.kilo.ai/api/gateway/';
    const allowed = service === 'ovh' ? ['chat/completions'] : ['chat/completions', 'responses', 'messages'];
    if (
      url.username ||
      url.password ||
      !url.href.startsWith(prefix) ||
      !allowed.includes(url.href.slice(prefix.length)) ||
      method !== 'POST'
    )
      throw new Error('Free catalog guard: non-approved inference URL/method');
    const text =
      typeof init.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : '';
    const body = JSON.parse(text);
    if (body.model !== model.id)
      throw new Error('Free catalog guard: model ID was rewritten');
    catalog.assertUsable(service, model.id);
    // OVH gets an allowlisted header set: no caller/SDK credentials, cookies or payment headers.
    const headers = service === 'ovh' ? new Headers() : new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of ['authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization', 'payment-signature', 'x-payment'])
      headers.delete(name);
    for (const [name, value] of Object.entries(
      anonymousHeaders(service),
    ))
      headers.set(name, value);
    headers.set('content-type', 'application/json');
    if (service === 'ovh') {
      try {
        const state = { signal: init.signal ?? (input instanceof Request ? input.signal : undefined), onWait };
        if (pacing) await pacing(state);
        else await catalog.ovhPacer.wait(model.id, state);
      }
      finally { onWait?.(0); }
      catalog.assertUsable(service, model.id); // It may have changed during the cancellable wait.
    }
    const response = await getFetch()(input, {
      ...init,
      headers,
      redirect: 'error',
    });
    if (service === 'ovh') catalog.ovhPacer.observe(model.id, response);
    onResponse?.(response);
    // Return the original stream unchanged. Pi owns parsing, tools, finish reasons, aborts.
    return response;
  };
}
export function requestPayload({
  catalog,
  service,
  id,
  getSelection,
  piLevel,
  getPiLevel,
  original,
}) {
  return async (payload, model) => {
    const changed = original ? await original(payload, model) : undefined;
    const actual = changed ?? payload;
    const entry = catalog.assertUsable(service, id);
    const params = selectThinking(
      entry,
      catalog.state,
      getSelection(service, id),
      getPiLevel ? getPiLevel() : piLevel,
    );
    return applyThinking(actual, params);
  };
}
