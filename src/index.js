import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { completions, responses, anthropic, classify } from "./sdk.js";
import {
  Catalog,
  PROVIDERS,
  recordKey,
  summary,
  atomicJSON,
} from "./catalog.js";
import { registrations, thinkingProfile, selectThinking } from "./models.js";
import { COMMANDS, commandHelp, argumentCompletions } from "./command-help.js";
import { thinkingSync, freeModelKey } from "./thinking-sync.js";
import { showCatalog } from "./catalog-viewer.js";
import { refreshReport } from "./catalog-report.js";
import { footerController } from "./footer.js";
import { OVH_BASE } from "./ovh.js";
import { scopedFetch, requestPayload, sessionId } from "./transport.js";

const STREAMS = {
  "openai-completions": completions,
  "openai-responses": responses,
  "anthropic-messages": anthropic,
};
/** Compatible with Pi 1.3.x. The factory always attempts all seven live sources before selection. */
export default async function freeCatalog(pi) {
  const directory = join(getAgentDir(), "free-catalog");
  const catalog = new Catalog({ file: join(directory, "catalog.json") });
  const selectionFile = join(directory, "thinking.json");
  let selections = {};
  try {
    const d = JSON.parse(await readFile(selectionFile, "utf8"));
    if (d && typeof d === "object" && !Array.isArray(d)) selections = d;
  } catch {}
  const uiFile = join(directory, "ui.json");
  let uiPreferences = { footer: "default" };
  try {
    const d = JSON.parse(await readFile(uiFile, "utf8"));
    if (["compact", "default"].includes(d.footer)) uiPreferences = d;
  } catch {}
  let saveQueue = Promise.resolve();
  const saveSelections = () => {
    const snapshot = structuredClone(selections);
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => atomicJSON(selectionFile, snapshot));
    return saveQueue;
  };
  const session = sessionId();
  let activeFreeModel = null;
  let activeContext = null;
  const getSelection = (service, id) =>
    selections[recordKey(service, id)] || "auto";
  const health = {};
  const noteResponse = (service, id, response) => {
    health[recordKey(service, id)] = {
      at: new Date().toISOString(),
      http: response.status,
      retryAfter: response.headers.get("retry-after"),
    };
  };
  await catalog.load();
  await catalog.refresh();
  function config(service) {
    return {
      api: "openai-completions",
      baseUrl:
        service === "ovh" ? OVH_BASE : service === "kilo"
          ? "https://api.kilo.ai/api/gateway"
          : "https://opencode.ai/inference/v1",
      apiKey: "public",
      authHeader: false,
      models: registrations(catalog.state, service),
      refreshModels: async () => registrations(catalog.state, service),
      streamSimple: (model, context, options = {}) => {
        const stream = STREAMS[model.api];
        if (!stream)
          throw new Error(
            `Transport '${model.api}' is not implemented. Model remains visible in /free-catalog; no protocol guessing.`,
          );
        const fetch = scopedFetch({
          catalog,
          service,
          model,
          session,
          onResponse: (r) => noteResponse(service, model.id, r),
          onWait: (ms) => activeContext?.ui.setStatus("free-ovh-rate", ms ? `OVH: waiting ${Math.ceil(ms / 1000)}s (2 RPM/IP/model; cancellable)` : undefined),
        });
        return stream(model, context, {
          ...options,
          apiKey: "public",
          ...(service === "ovh" ? { maxRetries: 0 } : {}),
          fetch,
          onPayload: requestPayload({
            catalog,
            service,
            id: model.id,
            getSelection: (service, id) => sync.resolveSelection(service, id),
            piLevel: options.reasoning ?? "off",
            getPiLevel: () =>
              activeFreeModel?.key === recordKey(service, model.id)
                ? pi.getThinkingLevel()
                : (options.reasoning ?? "off"),
            original: options.onPayload,
          }),
        });
      },
      classifiers: {
        "typesafe-system-one": {
          classify: async (model, context, options = {}) => {
            catalog.assertUsable(service, model.id);
            return classify(model, context, {
              ...options,
              apiKey: "public",
              fetch: scopedFetch({
                catalog,
                service,
                model,
                session,
                onResponse: (r) => noteResponse(service, model.id, r),
              }),
            });
          },
        },
      },
    };
  }
  const install = () => {
    for (const service of Object.keys(PROVIDERS))
      pi.registerProvider(PROVIDERS[service], config(service));
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
  const status = (ctx) => {
    const s = summary(catalog.state);
    ctx.ui.setStatus(
      "free-catalog",
      `Free chat: Kilo ${s.kilo.freeChat} · Zen ${s.zen.freeChat} · OVH ${s.ovh.freeChat}`,
    );
  };
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
  const updateFooter = footerController({
    pi,
    getMode: () => uiPreferences.footer,
  });
  pi.on("session_shutdown", async () => {
    sync.unbind();
    await saveQueue.catch(() => {});
  });
  pi.on("thinking_level_select", (event, ctx) => sync.selected(event, ctx));
  pi.on("model_select", (_event, ctx) => {
    activeContext = ctx;
    activeFreeModel = freeModelKey(ctx.model);
    sync.restore(ctx);
    updateFooter(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    activeFreeModel = freeModelKey(ctx.model);
    status(ctx);
    sync.restore(ctx);
    updateFooter(ctx, { claim: true });
    const bad = Object.entries(catalog.state.sources).filter(
      ([, s]) => !s.fresh,
    );
    if (bad.length)
      output(
        Object.values(catalog.state.entries).some(
          (e) => e.classification === "free" && e.listed,
        )
          ? "Catalog refresh incomplete; using the saved catalog where needed. Chat remains available. Details: /free-catalog."
          : "Catalog refresh incomplete and no saved free models are available. Restore connectivity and use /free-refresh. Details: /free-catalog.",
        ctx,
      );
    if (catalog.cacheWarning)
      output("Free catalog cache warning: " + catalog.cacheWarning, ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    activeContext = ctx;
    sync.reconcile(ctx);
  });
  // Pi owns source badges and layout. Keep package summaries short and help side-effect-free.
  function register(name, handler, values = () => []) {
    pi.registerCommand(name, {
      description: COMMANDS[name].description,
      getArgumentCompletions: (prefix) => argumentCompletions(values(), prefix),
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
  register("free-catalog", async (_args, ctx) => {
    await showCatalog(catalog.state, ctx, output, health);
  });
  register("free-refresh", async (_args, ctx) => {
    await catalog.refresh();
    sync.reconcile(ctx);
    install();
    status(ctx);
    sync.restore(ctx);
    output(refreshReport(catalog.state), ctx);
  });
  register(
    "free-footer",
    async (args, ctx) => {
      const mode = args.trim();
      if (!["compact", "default"].includes(mode)) {
        output(
          `Footer: ${uiPreferences.footer}.\n${commandHelp("free-footer")}`,
          ctx,
        );
        return;
      }
      uiPreferences.footer = mode;
      updateFooter(ctx, { claim: mode === "compact" });
      let warning = "";
      try {
        await atomicJSON(uiFile, uiPreferences);
      } catch (error) {
        warning = ` Not saved: ${error}. The mode applies only in this running session.`;
      }
      output(
        `Free model footer: ${mode}. Provider IDs and model picker are unchanged.${warning}`,
        ctx,
      );
    },
    () => ["compact", "default"],
  );
  register(
    "free-thinking",
    async (args, ctx) => {
      const model = freeModelKey(ctx.model),
        service = model?.service;
      if (!service || (ctx.model.type && ctx.model.type !== "chat")) {
        output("Select a free-kilo, free-zen or free-ovh chat model first.", ctx);
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
      sync.reconcile(ctx);
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
          `Thinking for ${service}/${entry.id}: ${mode}; Pi: ${pi.getThinkingLevel()}. Exact equivalents are synchronized; a subsequent Pi thinking change returns this model to auto. Use /free-thinking to inspect the effective native parameters.${warning}`,
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
}
