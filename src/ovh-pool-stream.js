import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { clean } from './catalog-report.js';
import { requestBudget } from './ovh-pool-compat.js';
import { abortable } from './ovh-cooldown.js';
import { MAX_ACTIVITY_STEPS } from './pool-activity.js';
import { failureDetail } from './free-pool-diagnostics.js';

// Per-attempt capability: never serialized into the provider payload.
export const POOL_REQUEST = Symbol('OVH managed request');
export function meaningfulActivity(event) {
  if (/^toolcall_(?:start|delta|end)$/.test(event.type)) return true;
  if (['text_delta', 'thinking_delta'].includes(event.type) && typeof event.delta === 'string' && /\S/.test(event.delta)) return true;
  return (event.partial?.content ?? []).some(block =>
    block.type === 'toolCall' || (block.type === 'text' && /\S/.test(block.text ?? '')) ||
    (block.type === 'thinking' && /\S/.test(block.thinking ?? '')));
}

/** One logical assistant response. Only the owned silent-start timeout or authorized pre-activity 429 permits another send. */
export function poolStream({ pool, model, context, options = {}, dispatch, onHandoff, onActivity, onWait }) {
  const result = createAssistantMessageEventStream();
  void (async () => {
    const configuration = pool.config;
    const key = model => pool.key ? pool.key(model) : model.id;
    const label = pool.label || 'OVH';
    const operationSignal = AbortSignal.any([options.signal, pool.shutdown.signal].filter(Boolean));
    const preflight = new AbortController();
    const preflightSignal = AbortSignal.any([operationSignal, preflight.signal]);
    const startedAt = performance.now(), attempted = new Set(), steps = [];
    let actual = model, release, preflightTimer, preflightExpired = false, firstSend = false;
    let activeAttempt, interesting = false, omitted = 0, outcome = 'error', failure;
    const addStep = step => {
      if (steps.length < MAX_ACTIVITY_STEPS) steps.push(step);
      else { steps[MAX_ACTIVITY_STEPS - 1] = step; omitted++; }
      return step;
    };
    const waitIndicator = (ms, kind) => {
      if (ms > 0 && kind !== 'start') {
        interesting = true;
        addStep({ model:pool.scope==='free'?'Free Pool':key(actual), state:'waiting', ...(pool.scope==='free'?{detail:'readiness-wait'}:{}), sent:false, elapsedMs:0 });
      }
      try { (onWait ?? pool.onWait)?.(ms, kind); }
      catch { /* A UI failure must not change request/quota behavior. */ }
    };
    const decision = (id, state, detail) => { interesting = true; addStep({ model: id, state, ...(detail?{detail}:{}), sent: false, elapsedMs: 0 }); };
    const expirePreflight = () => {
      preflightExpired = true;
      const error=Error(pool.waitFailure?pool.waitFailure():`${label} pool local wait budget expired before HTTP; no request was sent. ` + (pool.lastCheck || ''));
      if(pool.scope==='free')error.poolFailure='readiness-wait-expired';
      preflight.abort(error);
    };
    if (configuration.maxWaitMs) preflightTimer = setTimeout(expirePreflight, configuration.maxWaitMs);
    const check = () => {
      if (operationSignal.aborted) throw operationSignal.reason;
      if (pool.config !== configuration) throw Error(`${label} pool changed during the request; no further request was sent`);
      if (!firstSend && configuration.maxWaitMs && performance.now() - startedAt >= configuration.maxWaitMs && !preflightExpired) expirePreflight();
      if (!firstSend && preflightSignal.aborted) throw preflightSignal.reason;
    };
    try {
      release = await pool.acquire(preflightSignal);
      actual = await pool.choose(model, context, options, preflightSignal, decision, waitIndicator);
      check();
      let from = model;
      for (;;) {
        check();
        if (key(actual) !== key(from)) { interesting = true; await onHandoff(from, actual, operationSignal); check(); }
        const reason = pool.reason(from, actual, context, options);
        if (reason) throw Error(`${label} handoff revalidation failed: ` + reason);
        const budget = requestBudget(actual, context, options);
        if (budget.error) throw Error(budget.error);

        const controller = new AbortController();
        const signal = AbortSignal.any([operationSignal, controller.signal]);
        const identity = {};
        activeAttempt = identity;
        const step = addStep({ model: key(actual), state: 'selected', sent: false, elapsedMs: 0 });
        let responseTimer, responseDeadline = 0, sentAt = 0, timedOut = false, fatal = false, rateLimited = false, activitySeen = false;
        let committed = pool.scope==='free'?false:!configuration.responseStartTimeoutMs, finished = false, beginning = false;
        const buffered = [];
        const rateError=Error('Owned pre-activity HTTP 429');
        const timeoutError = Error(`${label} model did not start responding within ${configuration.responseStartTimeoutMs / 1000} seconds`);
        const stopTimer = () => { clearTimeout(responseTimer); responseDeadline = 0; waitIndicator(0); };
        const expireResponse = () => {
          if (fatal || finished || committed || operationSignal.aborted || activeAttempt !== identity) return;
          timedOut = true; interesting = true; controller.abort(timeoutError);
        };
        const checkAttempt = () => {
          check();
          if (activeAttempt !== identity) throw controller.signal.reason ?? Error(`Inactive ${label} attempt`);
          if (responseDeadline && performance.now() >= responseDeadline) expireResponse();
          if (signal.aborted) throw signal.reason;
        };
        const ticket = {
          check: checkAttempt,
          get timedOut() { return timedOut; },
          get rateLimited() { return rateLimited; },
          get cancelled() { return operationSignal.aborted; },
          begin() {
            checkAttempt();
            if (beginning || step.sent || attempted.has(key(actual))) throw Error(`${label} pool forbids a second HTTP dispatch to the same model`);
            const boundary = pool.reason(from, actual, context, options);
            if (boundary) throw Error(`${label} handoff revalidation failed before HTTP: ` + boundary);
            checkAttempt();
            beginning = true;
            const mark = () => {
              checkAttempt();
              const latest = pool.reason(from, actual, context, options);
              if (latest) throw Error('Handoff changed before HTTP: ' + latest);
              attempted.add(key(actual)); step.sent = true; sentAt = performance.now(); firstSend = true;
              clearTimeout(preflightTimer);
              if (configuration.responseStartTimeoutMs) {
                responseDeadline = sentAt + configuration.responseStartTimeoutMs;
                responseTimer = setTimeout(expireResponse, configuration.responseStartTimeoutMs);
                waitIndicator(configuration.responseStartTimeoutMs, 'start');
              }
            };
            // General-pool finite allowances are durably reserved before a send.
            if (pool.reserve) return pool.reserve(actual, checkAttempt).then(mark);
            mark();
          },
          headers(response) {
            // Known HTTP errors cannot turn into silent-start rotation while their body is read.
            // Do not apply a late canceled attempt's headers to another active attempt/session.
            if (activeAttempt !== identity || signal.aborted) {
              void response.body?.cancel().catch(() => {});
              throw signal.reason ?? Error(`Inactive ${label} attempt`);
            }
            if (!response.ok) { fatal = true; stopTimer(); }
          },
          rejectRateLimit(response) {
            checkAttempt();
            if(response.status!==429||pool.scope!=='free'||activitySeen||!step.sent||!pool.chooseAfterRateLimit)return false;
            rateLimited=true;interesting=true;stopTimer();controller.abort(rateError);
            void response.body?.cancel().catch(()=>{});
            return true;
          },
          failed() { if (!timedOut) { fatal = true; stopTimer(); } },
        };
        let stream;
        try {
          stream = await abortable(Promise.resolve(dispatch(actual, context, {
            ...options, maxTokens: budget.maxTokens, signal, [POOL_REQUEST]: ticket,
          }, key(actual) !== key(model) ? model : null)), signal);
          const iterator = stream[Symbol.asyncIterator]();
          for (;;) {
            const next = await abortable(iterator.next(), signal);
            if (next.done) break;
            const event = next.value;
            // A genuine terminal provider error wins over a deferred timer callback.
            if (event.type === 'error' && !timedOut) { fatal = true; stopTimer(); }
            checkAttempt();
            const meaningful = meaningfulActivity(event);
            if(meaningful)activitySeen=true;
            const terminal = event.type === 'done' || event.type === 'error';
            if (meaningful || terminal) {
              committed = true; stopTimer();
              for (const pending of buffered) result.push(pending);
              buffered.length = 0;
            }
            if (!committed) {
              if (buffered.length >= 32) throw Error(`${label} response contains too many empty structural events`);
              buffered.push(event);
            } else result.push(event);
            if (terminal) { finished = true; break; }
          }
          const message = await abortable(stream.result(), signal);
          // Some SDK adapters finish via result() without a terminal event.
          checkAttempt(); finished = true; stopTimer();
          if (!committed) { for (const event of buffered) result.push(event); }
          outcome = message.stopReason === 'aborted' ? 'aborted' : message.stopReason === 'error' ? 'error' : 'responded';
          step.state = outcome; step.elapsedMs = step.sent ? performance.now() - sentAt : 0;
          interesting ||= outcome !== 'responded';
          result.end(message);
          return;
        } catch (error) {
          step.elapsedMs = step.sent ? performance.now() - sentAt : 0;
          if (operationSignal.aborted) { step.state = 'aborted'; throw operationSignal.reason; }
          const retry429=rateLimited&&error===rateError&&!activitySeen&&step.sent;
          if (!retry429&&(!timedOut || error !== timeoutError || fatal || !step.sent)) { step.state = 'error'; throw error; }
          step.state = retry429?'rate-limited':'timed-out';
          // Identity invalidation happens before any subsequent selection/send. A provider
          // ignoring abort may finish later, but none of its events enters the outer stream.
          activeAttempt = undefined;
          controller.abort(retry429?rateError:timeoutError);
          from = actual;
          try { actual = await (retry429?pool.chooseAfterRateLimit:pool.chooseAfterTimeout).call(pool,from, context, options, operationSignal, attempted, decision); check(); }
          catch (selectionError) { outcome = 'exhausted'; throw selectionError; }
        } finally {
          stopTimer();
          if (activeAttempt === identity) activeAttempt = undefined;
          if (!finished && !controller.signal.aborted) controller.abort(Error(`${label} attempt closed`));
          // Do not await iterator.return()/result() from a signal-ignoring adapter.
          // abortable observes pending promise rejection; detached late events are never read.
        }
      }
    } catch (error) {
      const cancelled = operationSignal.aborted;
      if(!cancelled&&failureDetail(error?.poolFailure))failure=error.poolFailure;
      if (cancelled) outcome = 'aborted';
      interesting = true;
      const message = {
        role: 'assistant', content: [], api: actual.api, provider: actual.provider, model: actual.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: cancelled ? 'aborted' : 'error', timestamp: Date.now(),
        errorMessage: preflightExpired && !firstSend && !cancelled && error === preflight.signal.reason
          ? preflight.signal.reason.message : clean(error?.message || error),
      };
      result.push({ type: 'error', reason: message.stopReason, error: message }); result.end(message);
    } finally {
      clearTimeout(preflightTimer); if (release) { waitIndicator(0); release(); }
      if (interesting) {
        try { onActivity?.({ ...(pool.scope ? {scope:pool.scope} : {}), at: Date.now(), elapsedMs: performance.now() - startedAt, outcome, steps, omitted, ...(failure?{failure}:{}) }); }
        catch { /* A diagnostic write must not replace the actual inference outcome. */ }
      }
    }
  })();
  return result;
}
