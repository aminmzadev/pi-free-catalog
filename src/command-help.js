export const COMMANDS = Object.freeze({
  'free-pool': {
    description: 'Choose mixed-provider models',
    usage: '/free-pool [status|preview]',
    help: 'Choose free models across providers, thinking and scheduling.\nRound robin can use requests per visit and finite cycles.\nReview provider routing and Apply to save. Nothing sends a chat request.',
  },
  'free-ovh-pool': {
    description: 'Choose OVH fallback models',
    usage: '/free-ovh-pool [status]',
    help: 'Choose model order, thinking and waiting times.\nThe pool starts OFF. Review and Apply to save; Cancel keeps your settings.\nUse status to view settings and recent activity.',
  },
  'free-catalog': {
    description: 'Browse models and availability',
    usage: '/free-catalog',
    help: 'Browse models, prices and availability.\nType a model ID to search. Use arrows or Page Up/Down to scroll; Escape closes.\nThis does not update the model list.',
  },
  'free-refresh': {
    description: 'Update the model list',
    usage: '/free-refresh',
    help: 'Update model information from the catalog sources.\nIf a source is unavailable, keep usable saved information.\nThis does not send a chat request.',
  },
  'free-footer': {
    description: 'Choose footer display settings',
    usage: '/free-footer [compact|default|counts on|counts off]',
    help: 'Open display settings. Choose normal (default) or compact, and show or hide free chat counts.\nCounts start ON; your choice is saved.\nExample: /free-footer counts off\nThis changes only the display, not models or the pool.',
  },
  'free-thinking': {
    description: 'Choose model thinking',
    usage: '/free-thinking [auto|default|MODE]',
    help: 'Show thinking choices for the current free chat model, or choose one.\nauto follows Pi; default lets the provider decide. MODE is a listed model choice.\nExample: /free-thinking auto\nSet separate pool-model choices inside /free-ovh-pool.',
  },
  'free-export': {
    description: 'Save model information',
    usage: '/free-export [PATH]',
    help: "Save model details, source information and history as JSON.\nExample: /free-export models.json\nWithout a path, save free-catalog/export.json inside Pi's agent directory.",
  },
});
export function commandHelp(name) {
  const command = COMMANDS[name];
  return `${command.usage}\n${command.help}`;
}
/** Completion values are data, not executable actions. */
export function argumentCompletions(values, prefix) {
  const matching = [...new Set(['--help', ...values])].filter(value => value.startsWith(prefix));
  return matching.length ? matching.map(value => ({ value, label: value })) : null;
}
