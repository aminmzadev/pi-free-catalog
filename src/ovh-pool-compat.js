import { estimateContextTokens } from './ovh-pool-budget.js';
import { getDeclaredTools } from '@earendil-works/pi-ai/compat';
import { recordKey } from './catalog.js';
import { selectThinking } from './models.js';

export function safeBoundary(context,{toolsRunning=false}={}){
 if(toolsRunning)return 'A tool is still executing';
 const pending=new Set(),seen=new Set();
 for(const m of context.messages||[]){
  if(m.stopReason==='pending'||m.stopReason==='deferred'||m.deferred)return 'Pending/deferred assistant state cannot be transferred';
  for(const b of Array.isArray(m.content)?m.content:[]){
   if(m.role==='assistant'&&b.type==='toolCall'){
    if(typeof b.id!=='string'||!b.id||seen.has(b.id))return 'Ambiguous pending tool call IDs';seen.add(b.id);pending.add(b.id);
   }
  }
  if(m.role==='toolResult'){if(!pending.has(m.toolCallId))return 'Orphan or duplicate tool results cannot be transferred';pending.delete(m.toolCallId);}
 }
 return pending.size?'Unresolved tool calls must finish before a handoff':null;
}
// Reasoning history is explicitly expendable. This is a budget-only view, never
// the dispatched transcript: Pi retains messages/tool results in session state and
// applies its normal cross-model reasoning/signature conversion on the wire.
function handoffBudgetContext(context,target){
 return {...context,messages:(context.messages||[]).map(message=>{
  if(message.role!=='assistant')return message;
  const same=message.provider===target.provider&&message.api===target.api&&message.model===target.id;
  return {...message,
   ...(!same?{usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}}:{}),
   content:(message.content||[]).filter(block=>same||block.type!=='thinking').map(block=>{
    const {thoughtSignature,thinkingSignature,...rest}=block;return rest;
   }),
  };
 })};
}
export function compatibility({catalog,source,target,context,options={},getSelection=()=> 'auto',piLevel=options.reasoning??'off',toolsRunning=false}){
 const boundary=safeBoundary(context,{toolsRunning});if(boundary)return boundary;
 const a=catalog.state.entries[recordKey('ovh',source.id)],b=catalog.state.entries[recordKey('ovh',target.id)];
 if(!a||!b)return 'Missing exact model evidence';
 try{catalog.assertUsable('ovh',target.id);}catch{return 'Model is no longer eligible';}
 if(b.type!=='chat'||target.api!=='openai-completions')return 'Not an eligible OVH chat model';
 if(options.deferred)return 'Deferred request cannot change models';
 const tools=[...(context.tools||[]),...getDeclaredTools(context.messages||[])];
 const hasTools=tools.length>0||(context.messages||[]).some(m=>m.role==='toolResult'||(Array.isArray(m.content)&&m.content.some(c=>c.type==='toolCall')));
 if(hasTools&&b.metadata.tool_call!==true)return 'Tools are not explicitly supported';
 // Never guess image/audio/video token costs. Such transcripts remain on their selected model.
 for(const m of context.messages||[])for(const block of Array.isArray(m.content)?m.content:[])if(!['text','thinking','toolCall'].includes(block.type))return 'Opaque multimodal context budget is unverified';
 const declared=b.metadata.context_length??b.metadata.top_provider?.context_length??b.metadata.limit?.context??b.metadata.contextWindow;
 if(!Number.isSafeInteger(declared)||declared<=0)return 'Context window is unverified';
 const declaredOutput=b.metadata.top_provider?.max_completion_tokens??b.metadata.max_completion_tokens??b.metadata.limit?.output??b.metadata.maxTokens;
 if(!Number.isSafeInteger(declaredOutput)||declaredOutput<=0)return 'Output limit is unverified';
 const budget=requestBudget(target,context,options);if(budget.error)return budget.error;
 try{
  // Each target owns its supported mode. Equality with the source is deliberately
  // not required: pool-native thinking differences are explicitly authorized.
  selectThinking(b,catalog.state,getSelection('ovh',target.id),piLevel);
 }catch(error){return 'Target thinking unavailable: '+error.message;}

 return null;
}

/** Preserve explicit caller caps; derive implicit caps for the actual destination. */
export function requestBudget(target,context,options={}){
 const budgetContext=handoffBudgetContext(context,target);
 let bytes;try{bytes=Buffer.byteLength(JSON.stringify(budgetContext));}catch{return {error:'Context cannot be safely measured'};}
 const cost=Math.max(bytes,estimateContextTokens(budgetContext).tokens);
 const available=target.contextWindow-cost-4096;
 const output=options.maxTokens??Math.min(target.maxTokens,available);
 if(!Number.isSafeInteger(output)||output<=0)return {error:'Context does not fit with a safe output allowance'};
 if(output>target.maxTokens)return {error:'Output budget is incompatible'};
 if(output>available)return {error:'Context and output exceed the conservative budget'};
 return {maxTokens:output};
}
