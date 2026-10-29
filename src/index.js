import { migrateThinkingSelections } from "./provider-removal.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { completions, responses, anthropic } from "./sdk.js";
import {
  PROVIDERS,
  recordKey,
  atomicJSON,
} from "./catalog.js";
import { PagesCatalog } from './catalog-client.js';
import { registrations, thinkingProfile, selectThinking } from "./models.js";
import { COMMANDS, commandHelp, argumentCompletions } from "./command-help.js";
import { thinkingSync, freeModelKey, piLevelForNative } from "./thinking-sync.js";
import { showCatalog } from "./catalog-viewer.js";
import { refreshReport, clean } from "./catalog-report.js";
import { footerController } from "./footer.js";
import { FooterSettings, chatCountsStatus, editFooterSettings } from "./footer-settings.js";
import { OVH_BASE } from "./ovh.js";
import { scopedFetch, requestPayload } from "./transport.js";
import { OvhPool } from "./ovh-pool.js";
import { FreePool, poolKey, parsePoolKey } from "./free-pool.js";
import { explicitTools } from "./free-pool-compat.js";
import { editFreePool } from "./free-pool-editor.js";
import { abortable } from "./ovh-cooldown.js";
import { poolStream, POOL_REQUEST } from "./ovh-pool-stream.js";
import { editOvhPool } from "./ovh-pool-editor.js";
import { poolActivityUI, showPoolStatus } from "./pool-activity.js";

const STREAMS = {
  "openai-completions": completions,
  "openai-responses": responses,
  "anthropic-messages": anthropic,
};
/** Pages-first metadata; optional OVH handoff is isolated to a subsequent inference boundary. */
export default async function freeCatalog(pi) {
  const directory = join(getAgentDir(), "free-catalog");
  const catalog = new PagesCatalog({ file: join(directory, "catalog.json") });
  const selectionFile = join(directory, "thinking.json");
  let selections = {};
  try {
    const d = JSON.parse(await readFile(selectionFile, "utf8"));
    if (d && typeof d === "object" && !Array.isArray(d)) selections = migrateThinkingSelections(d);
  } catch {}
  const uiFile = join(directory, "ui.json");
  const uiSettings = new FooterSettings({ file: uiFile });
  await uiSettings.load();
  let saveQueue = Promise.resolve();
  const saveSelections = () => {
    const snapshot = structuredClone(selections);
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => atomicJSON(selectionFile, snapshot));
    return saveQueue;
  };
  let activeFreeModel = null;
  let activeContext = null;
  const getSelection = (service, id) =>
    selections[recordKey(service, id)] || "auto";
  const runningTools = new Set();
  let internalHandoff = false;
  const activityUI = poolActivityUI(pi);
  let sessionSignal = new AbortController(), sessionGeneration = 0;
  function clearSessionUI(ctx = activeContext) {
    activityUI.clear(ctx);
    sessionSignal.abort(new DOMException('Session or model changed', 'AbortError'));
    sessionSignal = new AbortController();
    sessionGeneration++;
    delete pool.lastCheck;
    delete pool.lastHandoff;
  }
  const legacyPool = new OvhPool({ catalog, file: join(directory, "ovh-pool.json"), getSelection,
    getPiLevel: () => pi.getThinkingLevel(), toolsRunning: () => runningTools.size > 0 });
  await legacyPool.load();
  const generalPool = new FreePool({catalog, file:join(directory,'free-pool.json'), ovhPool:legacyPool,
    getPiLevel:()=>pi.getThinkingLevel(), toolsRunning:()=>runningTools.size>0});
  await generalPool.load();
  let pool = generalPool.installed ? generalPool : legacyPool;
  const managed = model => pool === generalPool ? pool.manages(poolKey(model)) : model?.provider==='free-ovh' && pool.manages(model.id);
  const modeFor = model => pool.mode(pool === generalPool ? poolKey(model) : model.id);
  pool.onWait = (ms, kind) => activityUI.wait(activeContext, ms, kind, pool.label||'OVH');
  const health = {};
  const noteResponse = (service, id, response) => {
    health[recordKey(service, id)] = {
      at: new Date().toISOString(),
      http: response.status,
      retryAfter: response.headers.get("retry-after"),
    };
  };
  await catalog.load();
  const startupController = new AbortController();
  const cachedStartup = Object.keys(catalog.state.entries).length > 0;
  let startupRefresh, startupNoticeShown = false;
  if (!cachedStartup) await catalog.refresh({ signal: startupController.signal });
  function infer(service, model, context, options = {}, fallbackFrom = null) {
    const generation = sessionGeneration, requestContext = activeContext;
    const poolLabel=pool.label||'OVH';
    const stream = STREAMS[model.api];
    if (!stream)
      throw new Error(
        `Transport '${model.api}' is not implemented. Model remains visible in /free-catalog; no protocol guessing.`,
      );
    const fetch = scopedFetch({
      catalog,
      service,
      model,
      onResponse: (r) => {
        options[POOL_REQUEST]?.headers(r);
        noteResponse(service, model.id, r);
      },
      pacing: service === 'ovh' ? async state => {
        if(options[POOL_REQUEST])options[POOL_REQUEST].check();
        else {
          await pool.waitUnmanaged(model.id,state);
          await catalog.ovhPacer.wait(model.id,state);
          await pool.waitUnmanaged(model.id,state);
        }
      } : undefined,
      getFetch: () => async (input, init) => {
        if(pool===generalPool&&!options[POOL_REQUEST])await pool.waitUnmanaged(model.id,{signal:init.signal,onWait:ms=>activityUI.wait(requestContext,ms,'wait',pool.label||'OVH')},service);
        if (service === "ovh" || options[POOL_REQUEST]) pool.assertSlot(model.id,service);
        await options[POOL_REQUEST]?.begin();
        if (service === "ovh") pool.started(model.id,service);
        const pending = globalThis.fetch(input, init);
        if (options[POOL_REQUEST]) {
          // Settle the SDK's fetch even if an adapter ignores cancellation. Cancel
          // any response arriving after abort; never adopt it as another attempt.
          void Promise.resolve(pending).then(response => {
            if (init.signal?.aborted) void response.body?.cancel().catch(() => {});
          }, () => {});
          return abortable(pending, init.signal);
        }
        return pending;
      },
      onWait: (ms) => { if (!options[POOL_REQUEST] && generation === sessionGeneration) activityUI.wait(requestContext, ms, 'wait', pool.label||'OVH'); },
    });
    return stream(model, context, {
      ...options,
      apiKey: "public",
      ...(service === "ovh" || options[POOL_REQUEST] ? { maxRetries: 0 } : {}),
      fetch: service !== "ovh" && !options[POOL_REQUEST] && pool!==generalPool ? fetch : async (input, init) => {
        // Scoped guards stay unchanged; managed requests use one pool quota authority.
        try {
          if (options[POOL_REQUEST]) {
            const payload = JSON.parse(init.body), entry = catalog.state.entries[recordKey(service, model.id)];
            const output = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens ?? model.maxTokens;
            if (!Number.isSafeInteger(output) || output <= 0 || output > model.maxTokens || Buffer.byteLength(init.body) + output + 4096 > model.contextWindow)
              throw new Error(`${poolLabel} handoff final payload exceeds verified context/output limits`);
            if (payload.tools?.length && !(pool===generalPool?explicitTools(entry):entry.metadata.tool_call===true)) throw new Error(`${poolLabel} handoff requires explicit tool support`);
          }
          const response = await fetch(input, init);
          options[POOL_REQUEST]?.check();
          await pool.observe(model.id, response, {signal: init.signal, url: String(typeof input === "string" || input instanceof URL ? input : input.url)},service);
          if(response.status===429)options[POOL_REQUEST]?.rejectRateLimit?.(response);
          return response;
        } catch (error) {
          const ticket = options[POOL_REQUEST];
          ticket?.failed();
          // Our silent-attempt deadline is not evidence of a provider/network failure.
          // Leave all consumed attempts and any received quota barriers intact.
          if (!ticket?.timedOut && !ticket?.rateLimited && !ticket?.cancelled) pool.networkFailure(model.id,service);
          throw error;
        }
      },
      onPayload: requestPayload({
        catalog,
        service,
        id: model.id,
        getSelection: (service, id) => options[POOL_REQUEST] ? modeFor(model) : sync.resolveSelection(service, id),
        piLevel: options.reasoning ?? "off",
        getPiLevel: () =>
          activeFreeModel?.key === recordKey(service, model.id)
            ? pi.getThinkingLevel()
            : (options.reasoning ?? "off"),
        original: options.onPayload,
      }),
    });
  }
  async function handoff(from, target, signal) {
    if (signal?.aborted) throw signal.reason;
    if (!pi.setModel || activeContext?.model?.provider !== from.provider || activeContext?.model?.id !== from.id)
      throw new Error(`${pool.label||'OVH'} handoff needs the active Pi model; selection changed or runtime is unavailable`);
    internalHandoff = true;
    try {
      if (!await pi.setModel(target)) throw new Error(`Pi refused the selected ${pool.label||'OVH'} handoff`);
    } finally { internalHandoff = false; }
    if (activeContext?.model?.provider !== target.provider || activeContext?.model?.id !== target.id)
      throw new Error("Pi selection changed during handoff; request stopped before HTTP");
    restoreThinking(activeContext);
    pool.lastHandoff = {from: pool===generalPool?poolKey(from):from.id, to: pool===generalPool?poolKey(target):target.id};

  }
  function config(service) {
    return {
      api: "openai-completions",
      baseUrl:
        service === "ovh" ? OVH_BASE : "https://api.kilo.ai/api/gateway",
      apiKey: "public",
      authHeader: false,
      models: registrations(catalog.state, service),
      refreshModels: async () => registrations(catalog.state, service),
      streamSimple: (model, context, options = {}) => {
        if (managed(model)) {
          const generation = sessionGeneration, reportContext = activeContext;
          return poolStream({pool, model, context,
            options: {...options, signal: AbortSignal.any([options.signal, sessionSignal.signal].filter(Boolean))},
            dispatch: (target, transcript, opts, from) => infer(pool===generalPool?parsePoolKey(poolKey(target)).service:service, target, transcript, opts, from),
            onHandoff: handoff,
            onWait: (ms, kind) => { if (generation === sessionGeneration) activityUI.wait(reportContext, ms, kind, pool===generalPool?'Free':'OVH'); },
            onActivity: data => { if (generation === sessionGeneration) activityUI.record(data, reportContext); }});
        }
        return infer(service, model, context, options);
      },

    };
  }
  const install = () => {
    for (const service of Object.keys(PROVIDERS)) {
      const cfg=config(service),id=PROVIDERS[service];
      if(!generalPool.installed){pi.registerProvider(id,cfg);continue;}
      // Public native Provider registration intercepts ALL declared APIs. The
      // compatibility config's single-api stream hook cannot guard other APIs.
      const models=()=>registrations(catalog.state,service).map(m=>({...m,provider:id}));
      pi.registerProvider({id,name:id,baseUrl:cfg.baseUrl,
        auth:{apiKey:{name:'Public anonymous access',check:async()=>({type:'api_key',source:'public anonymous'}),resolve:async()=>({auth:{apiKey:'public'},source:'public anonymous'})}},
        getModels:()=>models().filter(m=>m.type==='chat'),getAllModels:models,
        stream:cfg.streamSimple,streamSimple:cfg.streamSimple,
      });
    }
  };
  install();
  const output = (text, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else
      pi.sendMessage({
        customType: "free-catalog",
        content: text,
        display: true,
      });
  };
  const countsStatus = chatCountsStatus({ getState: () => catalog.state, getEnabled: () => uiSettings.value.chatCounts });
  const status = ctx => countsStatus.update(ctx);
  const sync = thinkingSync({
    pi,
    catalog,
    getSelection,
    setSelection: (key, mode) => {
      selections[key] = mode;
    },
    save: saveSelections,
    output,
  });
  function restoreThinking(ctx) {
    if (freeModelKey(ctx.model) && managed(ctx.model)) {
      sync.unbind();
      const mode=modeFor(ctx.model),entry=catalog.state.entries[freeModelKey(ctx.model).key];
      if (entry) {
        try {
          const level=piLevelForNative(entry,catalog.state,mode);
          if(level!==null)pi.setThinkingLevel(level);
          else if(mode==='auto')pi.setThinkingLevel(pi.getThinkingLevel());
        } catch(error){output('Pool thinking unavailable: '+error.message,ctx);}
      }
      ctx.ui.setStatus('free-thinking',undefined);
      ctx.ui.setStatus('free-ovh-pool-thinking', undefined);
    } else {ctx.ui.setStatus('free-ovh-pool-thinking',undefined);sync.restore(ctx);}
  }
  function reconcileThinking(ctx) {
    if(freeModelKey(ctx.model)&&managed(ctx.model))restoreThinking(ctx);
    else sync.reconcile(ctx);
  }
  const updateFooter = footerController({
    pi,
    getMode: () => uiSettings.value.footer,
  });
  pi.on("session_shutdown", async () => {
    countsStatus.dispose();
    clearSessionUI();
    updateFooter.release(activeContext);
    sessionSignal.abort();
    pool.close();
    generalPool.close();
    legacyPool.close();
    await pool.changes.catch(() => {});
    await generalPool.changes.catch(() => {});
    startupController.abort();
    await startupRefresh?.catch(() => {});
    sync.unbind();
    await saveQueue.catch(() => {});
    await uiSettings.close();
  });
  pi.on("tool_execution_start", event => runningTools.add(event.toolCallId));
  pi.on("tool_execution_end", event => runningTools.delete(event.toolCallId));
  pi.on("thinking_level_select", (event, ctx) => { if (!internalHandoff) return sync.selected(event, ctx); });
  pi.on("model_select", (_event, ctx) => {
    if (!internalHandoff) clearSessionUI(ctx);
    else activityUI.clear(ctx);
    activeContext = ctx;
    activeFreeModel = freeModelKey(ctx.model);
    status(ctx);
    if (!internalHandoff) restoreThinking(ctx);
    updateFooter(ctx);
  });
  let startupFooterClaimed = false;
  pi.on("session_start", async (_event, ctx) => {
    clearSessionUI(ctx);
    activeContext = ctx;
    activeFreeModel = freeModelKey(ctx.model);
    status(ctx);
    restoreThinking(ctx);
    updateFooter(ctx, { claim: !startupFooterClaimed });
    startupFooterClaimed = true;
    const bad = Object.entries(catalog.state.sources).filter(
      ([, s]) => !s.fresh,
    );
    if (catalog.refreshWarning) {
      output(catalog.refreshWarning, ctx);
      startupNoticeShown = true;
    } else if (bad.length) {
      startupNoticeShown = true;
      output(
        Object.values(catalog.state.entries).some(
          (e) => e.classification === "free" && e.listed,
        )
          ? "Catalog refresh incomplete; using the saved catalog where needed. Chat remains available. Details: /free-catalog."
          : "Catalog refresh incomplete and no saved free models are available. Restore connectivity and use /free-refresh. Details: /free-catalog.",
        ctx,
      );
    }
    if (catalog.cacheWarning)
      output("Free catalog cache warning: " + catalog.cacheWarning, ctx);
    if (pool.warning || pool.config.enabled && pool.usable().length < 2) output(pool.report(), ctx);
  });
  for (const event of ['agent_end', 'agent_settled', 'turn_end', 'session_compact', 'session_compact_failed'])
    pi.on(event, (_event, ctx) => activityUI.clear(ctx));
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree'])
    pi.on(event, (_event, ctx) => clearSessionUI(ctx));
  pi.on("before_agent_start", async (_event, ctx) => {
    activeContext = ctx;
    reconcileThinking(ctx);
  });
  // Pi owns source badges and layout. Keep package summaries short and help side-effect-free.
  function register(name, handler, values = () => [], completions) {
    pi.registerCommand(name, {
      description: COMMANDS[name].description,
      getArgumentCompletions: completions ?? ((prefix) => argumentCompletions(values(), prefix)),
      handler: async (args, ctx) => {
        if (args.trim() === "--help") {
          output(commandHelp(name), ctx);
          return;
        }
        if (["free-catalog", "free-refresh"].includes(name) && args.trim()) {
          output(commandHelp(name), ctx);
          return;
        }
        await handler(args, ctx);
      },
    });
  }
  async function generalSettings(args,ctx) {
    const action=args.trim();
    if(action==='status'||!ctx.hasUI&&!action){await showPoolStatus(pool,ctx,output);return;}
    if(action==='preview'){output(generalPool.installed?generalPool.preview():'Open /free-pool to review a general pool first.',ctx);return;}
    if(action){output(commandHelp('free-pool'),ctx);return;}
    if(pool.busy||ctx.isIdle?.()===false){output('Change the free pool only while the agent is idle.',ctx);return;}
    if(!generalPool.installed)generalPool.importLegacy();
    output(await editFreePool(generalPool,pi,ctx),ctx);
    if(generalPool.installed){pool=generalPool;pool.onWait=(ms,kind)=>activityUI.wait(activeContext,ms,kind,'Free');install();}
    activityUI.clear(ctx);restoreThinking(ctx);
  }
  register('free-pool',generalSettings,()=>['status','preview']);
  register("free-ovh-pool", async (args, ctx) => {
    if(generalPool.installed)return generalSettings(args,ctx);
    const action=args.trim();
    if(action==='status'||!ctx.hasUI&&!action){await showPoolStatus(pool,ctx,output);return;}
    if(action){output('Use /free-ovh-pool to edit all settings together, or /free-ovh-pool status. No settings changed.',ctx);return;}
    if(ctx.isIdle?.()===false){output('Change the OVH pool only while the agent is idle.',ctx);return;}
    output(await editOvhPool(pool,pi,ctx),ctx);
    activityUI.clear(ctx);
    restoreThinking(ctx);
  }, () => ['status']);
  register("free-catalog", async (_args, ctx) => {
    await showCatalog(catalog.state, ctx, output, health);
  });
  register("free-refresh", async (_args, ctx) => {
    startupNoticeShown = true;
    await catalog.refresh();
    reconcileThinking(ctx);
    install();
    status(ctx);
    restoreThinking(ctx);
    output([catalog.refreshWarning, catalog.cacheWarning, refreshReport(catalog.state)].filter(Boolean).join("\n\n"), ctx);
  });
  async function applyFooterSettings(patch, ctx) {
    // Snapshot before awaiting; serialize both controls so rapid commands cannot
    // overwrite each other's saved preference. Never claim a footer for counts.
    const saved = uiSettings.set(patch).then(() => null, error => error);
    if (patch.footer) updateFooter(ctx, { claim: patch.footer === 'compact' });
    status(ctx);
    const error = await saved;
    const value = uiSettings.value;
    output(`Footer: ${value.footer}. Chat counts: ${value.chatCounts ? 'ON' : 'OFF'}.` +
      (error ? ' Not saved: display is applied in this session but may reset after restart.' : ''), ctx);
  }
  register('free-footer', async (args, ctx) => {
    const action = args.trim();
    if (!action) {
      await editFooterSettings({ ctx, getSettings: () => uiSettings.value, apply: applyFooterSettings, output });
    } else if (['compact', 'default'].includes(action)) await applyFooterSettings({ footer: action }, ctx);
    else if (action === 'counts on' || action === 'counts off') await applyFooterSettings({ chatCounts: action === 'counts on' }, ctx);
    else output(commandHelp('free-footer'), ctx);
  }, () => ['compact', 'default', 'counts on', 'counts off']);
  register(
    "free-thinking",
    async (args, ctx) => {
      const model = freeModelKey(ctx.model),
        service = model?.service;
      if (!service || (ctx.model.type && ctx.model.type !== "chat")) {
        output("Select a free-kilo or free-ovh chat model first.", ctx);
        return;
      }
      activeFreeModel = model;
      const entry = catalog.state.entries[model.key];
      if (!entry) {
        output(
          "No catalog metadata for the selected model. Use /free-refresh when connected.",
          ctx,
        );
        return;
      }
      reconcileThinking(ctx);
      const profile = thinkingProfile(entry, catalog.state),
        mode = args.trim();
      if (!mode) {
        let effectiveNativeParameters, effectiveNativeMode, selectionError;
        const controlMode = sync.resolveSelection(service, entry.id);
        try {
          effectiveNativeParameters = selectThinking(
            entry,
            catalog.state,
            controlMode,
            pi.getThinkingLevel(),
          );
          effectiveNativeMode = controlMode === "default" ? "provider-default" : controlMode !== "auto" ? controlMode : profile.piChoices[pi.getThinkingLevel()] || "provider-default";
        } catch (error) {
          selectionError = String(error);
        }
        output(
          JSON.stringify(
            {
              model: entry.id,
              selected: controlMode, // Backward-compatible machine-readable alias.
              controlMode,
              controlMeaning: controlMode === "auto" ? "Follow Pi (not provider default)" : controlMode === "default" ? "Preserve provider default; Pi level is not applied" : "Explicit advertised native override",
              effectiveNativeMode,
              piThinking: pi.getThinkingLevel(),
              source: profile.source,
              provenance: profile.provenance,
              effectiveNativeParameters,
              selectionError,
              nativeChoices: profile.choices,
              note: profile.note,
              recovery: selectionError
                ? "/free-thinking auto or /free-thinking default"
                : undefined,
            },
            null,
            2,
          ),
          ctx,
        );
        return;
      }
      try {
        if (!["auto", "default"].includes(mode))
          selectThinking(entry, catalog.state, mode);
        selections[model.key] = mode;
        sync.applyNative(mode, ctx);
        let warning = "";
        try {
          await saveSelections();
        } catch (error) {
          warning = ` Not saved: ${error}. The mode applies only in this running session.`;
        }
        output(
          `Thinking for ${entry.id}: ${mode}. ${mode==='default'?'The provider decides; Pi level is not applied.':mode!=='auto'&&piLevelForNative(entry,catalog.state,mode)===null?'This choice has no matching Pi level.':'Pi level: '+pi.getThinkingLevel()+'.'} Use /free-thinking to see details.${warning}`,
          ctx,
        );
      } catch (error) {
        output(String(error), ctx);
      }
    },
    () => {
      const entry =
        activeFreeModel && catalog.state.entries[activeFreeModel.key];
      return [
        "auto",
        "default",
        ...(entry
          ? Object.keys(thinkingProfile(entry, catalog.state).choices)
          : []),
      ];
    },
  );
  register("free-export", async (args, ctx) => {
    const path = args.trim() || join(directory, "export.json");
    await atomicJSON(path, catalog.state);
    output(`Complete free catalog evidence: ${path}`, ctx);
  });
  if (cachedStartup) {
    // One bounded startup task, not a poll: cached models are registered before network completion.
    startupRefresh = catalog.refresh({ signal: startupController.signal }).then(() => {
      if (startupController.signal.aborted) return;
      install();
      if (activeContext) {
        reconcileThinking(activeContext);
        status(activeContext);
        restoreThinking(activeContext);
        if (catalog.cacheWarning) output("Free catalog cache warning: " + catalog.cacheWarning, activeContext);
        if (catalog.refreshWarning && !startupNoticeShown) {
          output(catalog.refreshWarning, activeContext);
          startupNoticeShown = true;
        }
      }
    }).catch(() => {
      // Shutdown cancellation is expected. A refresh never invalidates the already loaded cache.
    });
  }

}
