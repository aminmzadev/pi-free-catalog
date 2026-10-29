import { clean } from './catalog-report.js';

export const MAX_COOLDOWN_EVIDENCE = 128;
const services = new Set(['kilo', 'ovh']);
const sources = new Set(['retry-after', 'fallback', 'ovh-ledger']);
const time = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const safeId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(id);
export const iso = n => time(n) ? new Date(n).toISOString() : 'unknown time';

/** Optional, allowlisted provenance. It NEVER authorizes or clears a cooldown. */
export function readCooldownEvidence(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_COOLDOWN_EVIDENCE) throw Error('Invalid cooldown evidence');
  return raw.map(e => {
    if (!e || !services.has(e.service) || !safeId(e.model) || !Number.isInteger(e.status) || e.status < 100 || e.status > 599 ||
        !time(e.at) || !time(e.until) || e.until<=e.at || !['service', 'model'].includes(e.scope) || !sources.has(e.source) ||
        !['valid', 'missing', 'invalid'].includes(e.retryAfterState) ||
        (e.source==='retry-after'&&e.retryAfterState!=='valid') ||
        (e.source==='fallback'&&(e.status!==429||e.retryAfterState==='valid'||e.service==='ovh')) ||
        (e.source==='ovh-ledger'&&e.service!=='ovh') ||
        !(e.retryAfter === null || typeof e.retryAfter === 'string' && e.retryAfter.length <= 128 && /^[\x20-\x7e]*$/.test(e.retryAfter))) throw Error('Invalid cooldown evidence');
    return Object.freeze({ service:e.service, model:e.model, status:e.status, at:e.at, until:e.until,
      scope:e.scope, source:e.source, retryAfterState:e.retryAfterState, retryAfter:e.retryAfter });
  });
}
export function cooldownEvidenceText(e) {
  const origin = e.source === 'retry-after' ? `provider Retry-After: ${e.retryAfter ?? 'valid value (not retained)'}` :
    e.source === 'fallback' ? `package fallback: 61 seconds (Retry-After ${e.retryAfterState}); NOT a verified provider limit` : 'effective OVH quota/cooldown ledger after this response; earlier constraints may contribute';
  const scope = e.service === 'ovh' ? `${e.scope}-wide, according to OVH ledger association` :
    e.scope==='service'?'service-wide, explicitly declared by the server X-Ratelimit-Scope header':'model-local package handling; upstream quota scope is unverified';
  return `${clean(e.service)}/${clean(e.model)}; HTTP ${e.status}; observed ${iso(e.at)}; deadline ${iso(e.until)}; ${origin}; scope: ${scope}`;
}

const details = Object.freeze({
  'readiness-wait': 'Waiting for a compatible selected model; no target has been dispatched.',
  'tools-unverified': 'This request includes tools or tool results, but catalog evidence does not explicitly support tools for this model. No capability override is applied.',
  'request-fit': 'The actual request cannot be verified to fit this model: context, output or multimodal budget is incompatible or unverified.',
  'thinking-unavailable': 'The selected native thinking setting is no longer available for this target.',
  'boundary': 'The current tool/request boundary does not permit a safe handoff.',
  'unsupported-transport': 'The declared chat transport is not verified through the anonymous route guard.',
  'unavailable': 'This exact provider/model is not currently eligible in the cached catalog.',
  'cooldown': 'A local quota or cooldown gate was active at this historical check; inspect current status for its remaining time and source.',
  'other-compatibility': 'The target did not pass the actual-request compatibility checks.',
});
export function compatibilityCode(reason) {
  if (/Tools are not explicitly supported/.test(reason)) return 'tools-unverified';
  if (/thinking/i.test(reason)) return 'thinking-unavailable';
  if (/budget|fit|Context\/output|multimodal/i.test(reason)) return 'request-fit';
  if (/transport/i.test(reason)) return 'unsupported-transport';
  if (/Unresolved|boundary|Deferred|running tool|pending tool|tool is still executing|Orphan|duplicate tool/i.test(reason)) return 'boundary';
  if (/eligible|Unavailable/i.test(reason)) return 'unavailable';
  return 'other-compatibility';
}
export const activityDetail = code => typeof code==='string' && Object.hasOwn(details, code) ? details[code] : '';

const failures = Object.freeze({
  'readiness-wait-expired': 'Readiness wait expired before dispatch; the response-start timer did not start. No cooldown was cleared.',
  'finite-allowance-exhausted': 'Finite scheduling allowance exhausted. Skipped visits count; explicitly review a restart or leave the pool.',
  'review-required': 'Saved runtime requires repair and an explicit reviewed restart; no automatic reset is allowed.',
  'no-compatible-model': 'No selected model could safely handle the actual request. A longer wait does not add missing capabilities.',
  'cooldown-active': 'Compatible models were cooling and readiness waiting was disabled.',
  'rate-limit-exhausted': 'A 429 was received and no untried ready compatible model remains; the pool stays enabled and continuous, but cannot manufacture an available model.',
  'response-start-exhausted': 'The owned silent-response deadline expired and no untried compatible model was ready.',
});
export const failureDetail = code => typeof code==='string' && Object.hasOwn(failures, code) ? failures[code] : '';
