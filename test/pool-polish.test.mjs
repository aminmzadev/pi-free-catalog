import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { visibleWidth, Text } from '@earendil-works/pi-tui';
import { poolActivityUI, boundedActivity, activityText, recentActivity, createPoolStatusViewer, ACTIVITY_TYPE, OWNED_STATUS_KEYS } from '../src/pool-activity.js';
import { COMMANDS, commandHelp } from '../src/command-help.js';

function fixture() {
 const statuses=new Map([['another-extension','keep me']]); const entries=[]; const renderers=new Map();
 const terminal=new EventEmitter(); terminal.columns=32;
 const ctx={hasUI:true,ui:{setStatus:(k,v)=>v===undefined?statuses.delete(k):statuses.set(k,v)},sessionManager:{getBranch:()=>entries}};
 const pi={registerEntryRenderer:(k,r)=>renderers.set(k,r),appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
 return {statuses,entries,renderers,ctx,terminal,ui:poolActivityUI(pi,{terminal})};
}
test('transient indicator fits narrow widths, follows resize, clears only owned keys and disposes listeners',()=>{
 const x=fixture(); for(const k of OWNED_STATUS_KEYS)x.statuses.set(k,'stale');
 x.ui.clear(x.ctx);assert.deepEqual([...x.statuses],[['another-extension','keep me']]);
 for(const width of [1,2,8,24,32,40,80]){
  x.terminal.columns=width;x.ui.wait(x.ctx,60000,'start');x.terminal.emit('resize');
  assert.ok(visibleWidth(x.statuses.get('free-ovh-activity'))<=width);
  assert.equal(x.terminal.listenerCount('resize'),1);
 }
 x.ui.clear(x.ctx);assert.equal(x.terminal.listenerCount('resize'),0);assert.deepEqual([...x.statuses],[['another-extension','keep me']]);
});
test('activity is context-free, bounded and contains no prompt, reasoning, results or raw errors',()=>{
 const x=fixture();const raw={outcome:'error',at:1,elapsedMs:3,prompt:'SECRET_PROMPT',error:'RAW_PROVIDER_BODY',steps:Array.from({length:2000},(_,i)=>({model:'model-'+i+'\x1b[31m',state:'timed-out',sent:true,elapsedMs:50,thinking:'SECRET_THOUGHT',result:'SECRET_TOOL'}))};
 const data=boundedActivity(raw);assert.ok(data.steps.length<=24);assert.ok(JSON.stringify(data).length<12000);assert.equal(data.omitted,1976);
 assert.doesNotMatch(JSON.stringify(data),/SECRET|RAW_PROVIDER|\\u001b/);
 x.ui.record(raw,x.ctx);assert.equal(x.entries.length,1);assert.equal(x.entries[0].type,'custom');assert.equal(x.entries[0].customType,ACTIVITY_TYPE);assert.ok(x.renderers.has(ACTIVITY_TYPE));
 const component=x.renderers.get(ACTIVITY_TYPE)(x.entries[0],{expanded:true},{fg:(_k,s)=>s});
 for(const w of [24,32,40,80])for(const line of component.render(w))assert.ok(visibleWidth(line)<=w);
 x.ui.clear(x.ctx);
});
test('recent activity uses only current branch, caps results and safely sanitizes resumed entries',()=>{
 const x=fixture();for(let i=0;i<35;i++)x.ui.record({at:i,outcome:'responded',steps:[{model:'m'+i,state:'responded',sent:true}]},x.ctx);
 x.entries.push({type:'custom_message',customType:ACTIVITY_TYPE,data:{prompt:'never read'}});
 assert.equal(recentActivity(x.ctx).length,20);assert.equal(recentActivity(x.ctx)[0].at,34);
 const resumed={...x.ctx,sessionManager:{getBranch:()=>x.entries.slice(0,2)}};assert.equal(recentActivity(resumed).length,2);
 assert.match(activityText(recentActivity(resumed)[0],true),/m1/);
});
test('status viewer wraps and scrolls without stealing input permanently, including after resize',()=>{
 const x=fixture();let closed=0,renders=0;const terminal={rows:12};
 const viewer=createPoolStatusViewer('Pool settings\n'+Array.from({length:100},(_,i)=>`${i+1}. model-${'long-name-'.repeat(20)}`).join('\n'),{tui:{terminal,requestRender:()=>renders++},done:()=>closed++});
 for(const width of [24,32,40,80]){const lines=viewer.render(width);assert.ok(lines.length<=12);for(const l of lines)assert.ok(visibleWidth(l)<=width);}
 viewer.handleInput('\x1b[F');assert.match(viewer.render(32).at(-2),/\/ /);viewer.handleInput('\x1b[H');viewer.handleInput('\x1b');assert.equal(closed,1);assert.ok(renders>=2);x.ui.clear(x.ctx);
});
test('all seven help texts are concise plain English with current usage, not implementation history',()=>{
 assert.equal(Object.keys(COMMANDS).length,7);
 for(const [name,c]of Object.entries(COMMANDS)){
  assert.ok(c.description.length<=30);assert.ok(c.help.length<=450,name);assert.match(commandHelp(name),new RegExp('/'+name));
  assert.doesNotMatch(c.help,/migration|retired|supersed|classified 429|single custom-footer slot|preflight/i);
 }
});

test('worst-case Unicode diagnostics remain byte-bounded and metadata fields are allowlisted',()=>{
 const data=boundedActivity({steps:Array.from({length:1000},()=>({model:'\u4e00'.repeat(1000),state:'responded',sent:true,elapsedMs:Infinity,secret:'not stored'}))});
 assert.ok(Buffer.byteLength(JSON.stringify(data))<24576);assert.ok(data.steps.every(s=>s.model.length===256));assert.doesNotMatch(JSON.stringify(data),/secret|not stored/);
});
