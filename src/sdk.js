// Use Pi's public, loader-aliased entrypoints. Importing pi-ai/api/* directly
// breaks unpacked local packages in Pi 1.3's jiti alias resolver.
import {
  openAICompletionsApi,
  openAIResponsesApi,
  anthropicMessagesApi,
} from '@earendil-works/pi-ai/compat';
const completionsAPI = openAICompletionsApi(),
  responsesAPI = openAIResponsesApi(),
  anthropicAPI = anthropicMessagesApi();
export const completions = (...args) => completionsAPI.streamSimple(...args);
export const responses = (...args) => responsesAPI.streamSimple(...args);
export const anthropic = (...args) => anthropicAPI.streamSimple(...args);
