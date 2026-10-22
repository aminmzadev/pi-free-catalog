// Use Pi's public, loader-aliased entrypoints. Importing pi-ai/api/* directly
// breaks unpacked local packages in Pi 1.3's jiti alias resolver.
import {
  openAICompletionsApi,
  openAIResponsesApi,
  anthropicMessagesApi,
} from '@earendil-works/pi-ai/compat';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
const completionsAPI = openAICompletionsApi(),
  responsesAPI = openAIResponsesApi(),
  anthropicAPI = anthropicMessagesApi();
const classifierProvider = builtinProviders().find((p) => p.id === 'opencode');
export const completions = (...args) => completionsAPI.streamSimple(...args);
export const responses = (...args) => responsesAPI.streamSimple(...args);
export const anthropic = (...args) => anthropicAPI.streamSimple(...args);
// Only reuse the native classifier implementation. Built-in MODEL LISTS are
// NEVER used to discover or price models; that always uses the seven live sources.
export const classify = (...args) => {
  if (!classifierProvider?.classify)
    throw new Error(
      'Pi native OpenCode classifier implementation unavailable; requires compatible Pi >=1.3',
    );
  return classifierProvider.classify(...args);
};
