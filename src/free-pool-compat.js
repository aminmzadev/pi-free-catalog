import { getDeclaredTools } from '@earendil-works/pi-ai/compat';
import { safeBoundary, requestBudget } from './ovh-pool-compat.js';
import { recordKey } from './catalog.js';
import { selectThinking } from './models.js';
import { parsePoolKey, poolKey } from './free-pool.js';

export function explicitTools(entry) {
  const m=entry?.metadata;
  return m?.tool_call===true || m?.tools===true || m?.capabilities?.tools===true || (Array.isArray(m?.supported_parameters)&&m.supported_parameters.includes('tools'));
}
export function freeCompatibility({catalog,source,target,context,options={},mode='default',piLevel='off',toolsRunning=false}) {
  const boundary=safeBoundary(context,{toolsRunning});if(boundary)return boundary;
  let a,b,service;
  try{a=catalog.state.entries[poolKey(source)];const parsed=parsePoolKey(poolKey(target));service=parsed.service;b=catalog.assertUsable(service,target.id);}catch{return 'Missing eligible exact provider/model evidence';}
  if(!a||!b||b.type!=='chat'||!['openai-completions','openai-responses'].includes(target.api))return 'Unsupported chat transport';
  if(options.deferred)return 'Deferred request cannot change models';
  const tools=[...(context.tools||[]),...getDeclaredTools(context.messages||[])];
  const hasTools=tools.length>0||(context.messages||[]).some(m=>m.role==='toolResult'||(Array.isArray(m.content)&&m.content.some(c=>c.type==='toolCall')));
  if(hasTools&&!explicitTools(b))return 'Tools are not explicitly supported';
  for(const m of context.messages||[])for(const block of Array.isArray(m.content)?m.content:[])if(!['text','thinking','toolCall'].includes(block.type))return 'Opaque multimodal context budget is unverified';
  const declared=b.metadata.context_length??b.metadata.top_provider?.context_length??b.metadata.limit?.context??b.metadata.contextWindow;
  const output=b.metadata.top_provider?.max_completion_tokens??b.metadata.max_completion_tokens??b.metadata.limit?.output??b.metadata.maxTokens;
  if(!Number.isSafeInteger(declared)||declared<=0||!Number.isSafeInteger(output)||output<=0)return 'Context/output limits are unverified';
  const budget=requestBudget(target,context,options);if(budget.error)return budget.error;
  try{selectThinking(b,catalog.state,mode,piLevel);}catch(e){return 'Target thinking unavailable: '+e.message;}
  return null;
}
