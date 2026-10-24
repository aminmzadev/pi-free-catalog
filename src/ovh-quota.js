const ENDPOINT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const WINDOW = 61000; // conservative local window when server timing is unavailable

/** Trust only agreeing, model-associated anonymous minute counters, never prose. */
export function minuteQuota(response, { id, url, entitlement, now }) {
  if (!response.ok || response.redirected || url !== ENDPOINT || !id || entitlement !== 2) return null;
  const h = response.headers;
  if (h.has('x-ratelimit-model') && h.get('x-ratelimit-model') !== id) return null;
  if (h.has('x-ratelimit-scope') && h.get('x-ratelimit-scope') !== 'model') return null;
  if (h.has('x-ratelimit-window') && h.get('x-ratelimit-window') !== '60') return null;
  if (h.has('ratelimit-policy')) return null;
  for (const [key] of h) if (/^x-ratelimit-(?:limit|remaining|reset)-/.test(key) && !/^x-ratelimit-(?:limit|remaining)-minute$/.test(key)) return null;
  if (h.get('ratelimit-limit') !== '2' || h.get('x-ratelimit-limit-minute') !== '2') return null;
  const remaining = h.get('ratelimit-remaining');
  if (!/^[01]$/.test(remaining || '') || h.get('x-ratelimit-remaining-minute') !== remaining) return null;
  const reset = h.get('ratelimit-reset');
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(reset || '')) return null;
  // Captured OVH reset is a relative duration, not an epoch. Start at receipt,
  // add a one-second boundary margin; never move it earlier using client clock skew.
  return { remaining: Number(remaining), until: now + Number(reset) * 1000 + 1000 };
}

/** One extension-local authority. Server/IP capacity is never guaranteed. */
export class OvhQuota {
  constructor(now = () => Date.now()) { this.now = now; this.models = new Map(); }
  entry(id) {
    const t = this.now();
    if (!this.models.has(id)) this.models.set(id, { attempts: [], known: null, unsafe: false });
    const e = this.models.get(id);
    if (e.known && e.known.until <= t) {
      const reset = e.known.until;
      e.attempts = e.attempts.filter(a => a.at >= reset); e.known = null; e.unsafe = false;
    }
    e.attempts = e.attempts.filter(a => a.at + WINDOW > t);
    if (!e.attempts.length && !e.known) e.unsafe = false;
    return e;
  }
  started(id) {
    const e = this.entry(id);
    e.attempts.push({ at: this.now(), success: false });
    if (e.known) { e.known.remaining = Math.max(0, e.known.remaining - 1); e.known.exhaustedEvidence = false; }
  }
  observe(id, response, request) {
    const e = this.entry(id);
    if (response.ok) {
      const a = e.attempts.at(-1); if (a) a.success = true;
      let q = minuteQuota(response, { ...request, id, now: this.now() });
      const prior = e.known;
      if (q && prior) {
        // A rising counter is not a fresh window unless the previous server
        // reset is actually near and the new reset rolls forward. Stale 200
        // responses must not mint additional slots in the same minute.
        const rolled = prior.until - this.now() <= 2000 && q.until > prior.until + 2000;
        if (!rolled && q.remaining > prior.remaining) q = null;
        else if (!rolled) q.until = Math.max(q.until, prior.until);
      }
      // Invalid/contradictory observations cannot leave an earlier optimistic slot.
      e.known = q ? { ...q, exhaustedEvidence: q.remaining === 0 } : null;
      e.unsafe = !q && [...response.headers.keys()].some(k=>/^(?:x-)?ratelimit-/.test(k));
    } else { e.known = null; e.unsafe = true; }
  }
  failed(id) { const e = this.entry(id); e.known = null; e.unsafe = true; }
  until(id) {
    const e = this.entry(id);
    if (e.known) return e.known.remaining > 0 ? 0 : e.known.until;
    return e.attempts.length >= 2 ? e.attempts[0].at + WINDOW : 0;
  }
  exhausted(id) {
    const e = this.entry(id);
    if (e.unsafe) return false;
    return e.known ? e.known.exhaustedEvidence : e.attempts.filter(a => a.success).length >= 2;
  }
  describe(id) {
    const e = this.entry(id), until = this.until(id);
    return { remaining: e.known ? e.known.remaining : Math.max(0, 2 - e.attempts.length),
      evidence: e.known ? 'server minute headers' : 'conservative local accounting',
      readyInMs: Math.max(0, until - this.now()) };
  }
}
