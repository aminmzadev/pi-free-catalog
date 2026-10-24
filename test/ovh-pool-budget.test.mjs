import test from 'node:test';
import assert from 'node:assert/strict';
import * as local from '../src/ovh-pool-budget.js';
// Reference-only dev dependency. Production never imports SDK utility subpaths.
import * as reference from '@earendil-works/pi-ai/utils/estimate';
import { normalizeContext } from '@earendil-works/pi-ai/compat';

const usage=(extra={})=>({input:100,output:20,cacheRead:30,cacheWrite:40,totalTokens:0,...extra});
const assistant=(extra={})=>({role:'assistant',content:[{type:'text',text:'previous reply'}],usage:usage(),timestamp:10,stopReason:'stop',...extra});
const user=(text='hello',timestamp=1)=>({role:'user',content:text,timestamp});
const system={role:'system',content:[{type:'text',text:'System text'}],sections:{policy:'Keep tools safe',removed:null},toolsAdded:[{name:'read',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}}}}],toolsRemoved:['old'],timestamp:0};
const image={type:'image',data:'AA==',mimeType:'image/png'};
const contexts={
 empty:[],
 plain:[user()],
 unicode:[user('Hello 👋\nUnicode and ASCII')],
 systemAndTools:[system,user()],
 images:[user([{type:'text',text:'look'},image])],
 toolResult:[{role:'toolResult',content:[{type:'text',text:'done'},image],timestamp:3}],
 reasoning:[assistant({content:[{type:'thinking',thinking:'expendable thought'},{type:'text',text:'answer'},{type:'toolCall',name:'read',arguments:{path:'a'}}],usage:usage({input:0,output:0,cacheRead:0,cacheWrite:0})})],
 reportedUsage:[user(),assistant()],
 totalOverridesBreakdown:[assistant({usage:usage({totalTokens:777})})],
 trailing:[user(),assistant(),user('next question',11)],
 erroredUsageIgnored:[assistant({stopReason:'error'})],
 abortedUsageIgnored:[assistant({stopReason:'aborted'})],
 newerPrefixInvalidatesOldUsage:[{...system,timestamp:20},assistant(),user('tail',21)],
 newerPrefixAndFreshUsage:[{...system,timestamp:20},assistant(),assistant({timestamp:22}),user('tail',23)],
};
for(const [name,messages] of Object.entries(contexts)) test(`vendored estimator preserves Pi 1.4.0 semantics: ${name}`,()=>{
 assert.deepEqual(local.estimateContextTokens(messages),reference.estimateContextTokens(messages));
 assert.deepEqual(local.estimateContextTokens({messages}),reference.estimateContextTokens({messages}));
 for(const message of messages)assert.equal(local.estimateMessageTokens(message),reference.estimateMessageTokens(message));
});
test('normalized system/tool declarations preserve budgeting and input objects',()=>{
 const context=normalizeContext({systemPrompt:'Keep it short',tools:[{name:'read',description:'Read',parameters:{type:'object'}}],messages:[user()]});
 const before=structuredClone(context);
 assert.deepEqual(local.estimateContextTokens(context),reference.estimateContextTokens(context));
 assert.deepEqual(context,before);
});
test('text/image estimates, cached usage, and unserializable arguments match the pinned implementation',()=>{
 for(const n of [0,1,3,4,7,31,4096,131072])assert.equal(local.estimateTextTokens('x'.repeat(n)),reference.estimateTextTokens('x'.repeat(n)));
 for(const value of ['',[],[image],[{type:'text',text:'hello'},image]])assert.equal(local.estimateTextAndImageContentTokens(value),reference.estimateTextAndImageContentTokens(value));
 for(const u of [usage(),usage({totalTokens:999}),usage({input:0,output:0,cacheRead:0,cacheWrite:0})])assert.equal(local.calculateContextTokens(u),reference.calculateContextTokens(u));
 const circular={};circular.self=circular;
 for(const args of [undefined,BigInt(1),circular]){
  const message=assistant({content:[{type:'toolCall',name:'read',arguments:args}]});
  assert.equal(local.estimateMessageTokens(message),reference.estimateMessageTokens(message));
 }
});
test('100 deterministic mixed transcripts preserve usage anchors and trailing estimates',()=>{
 let state=140;
 const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
 for(let i=0;i<100;i++){
  const messages=[];
  for(let j=0,n=random(20);j<n;j++){
   const timestamp=random(40);
   messages.push(random(2)?user('x'.repeat(random(1000)),timestamp):assistant({timestamp,stopReason:['stop','error','aborted'][random(3)],usage:usage({totalTokens:random(10000)})}));
  }
  assert.deepEqual(local.estimateContextTokens({messages}),reference.estimateContextTokens({messages}),`fixture ${i}`);
 }
});
