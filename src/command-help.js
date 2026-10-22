export const COMMANDS = Object.freeze({
  "free-catalog": {
    description: "Show models and source health",
    usage: "/free-catalog",
    help: "Open a scrollable catalog with ID search. Shows pricing reasons, provider-list presence, record fetch times, lifecycle declarations, and Pi registration separately. Arrows/PageUp/PageDown scroll; Home/End jump; Escape closes. Viewing never refreshes sources.",
  },
  "free-refresh": {
    description: "Refresh model catalogs",
    usage: "/free-refresh",
    help: "Fetch all seven sources and reconcile model availability. Chat and thinking changes never trigger this refresh.",
  },
  "free-footer": {
    description: "Set footer mode",
    usage: "/free-footer [compact|default]",
    help: "Inspect or set footer mode. Compact explicitly claims Pi's single custom-footer slot; default releases it only while we still own it. Provider IDs never change.",
  },
  "free-thinking": {
    description: "Inspect or set thinking",
    usage: "/free-thinking [auto|default|MODE]",
    help: "Inspect or select thinking for the current free chat model. Auto follows Pi; default preserves the provider default; MODE must be advertised for that model. Native choices with exact Pi equivalents synchronize both ways.",
  },
  "free-export": {
    description: "Export catalog evidence",
    usage: "/free-export [PATH]",
    help: "Export complete readable JSON, including raw sources, all classified IDs, and recent lifecycle history. Default: free-catalog/export.json in Pi's agent directory.",
  },
});

export function commandHelp(name) {
  const command = COMMANDS[name];
  return `${command.usage}\n${command.help}`;
}

/** Completion values are data, not executable actions. */
export function argumentCompletions(values, prefix) {
  const matching = [...new Set(["--help", ...values])].filter((value) =>
    value.startsWith(prefix),
  );
  return matching.length
    ? matching.map((value) => ({ value, label: value }))
    : null;
}
