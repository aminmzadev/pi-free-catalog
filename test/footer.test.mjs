import test from 'node:test';import assert from 'node:assert/strict';
import {FooterComponent,InteractiveMode,initTheme} from '@earendil-works/pi-coding-agent';
import {freeFooter,footerController} from '../src/footer.js';
initTheme('dark');
function setup(){
 let renders=0,disposed=0,compact=false;
 const model={id:'beam-free',provider:'free-zen',reasoning:true,contextWindow:1048576};
 const entries=[{type:'message',message:{role:'assistant',usage:{input:1234,output:543,cacheRead:1000,cacheWrite:200,cost:{total:0.12}}}}];
 const manager={getCwd:()=>'/home/dev/demo',getSessionName:()=> 'review',getEntries:()=>entries,getEntryCount:()=>entries.length,getSessionId:()=> 'id',getLeafId:()=> 'leaf'};
 const ctx={mode:'tui',model,sessionManager:manager,getContextUsage:()=>({contextWindow:1048576,percent:42,tokens:440401}),ui:{}};
 const data={getGitBranch:()=> 'main',getExtensionStatuses:()=>new Map([['free-catalog','Free: Kilo 17 · Zen 9'],['warning','STALE source warning']]),getAvailableProviderCount:()=>3,onBranchChange:fn=>{return()=>disposed++;}};
 const pi={getThinkingLevel:()=> 'low',getSettings:()=>({compaction:{enabled:compact}})};
 const original=new FooterComponent({state:{model,thinkingLevel:'low'},sessionManager:manager,getContextUsage:ctx.getContextUsage,modelRuntime:{isUsingSubscription:()=>false}},data);original.setAutoCompactEnabled(false);
 const footer=freeFooter(pi,ctx,{requestRender:()=>renders++},data);
 return {ctx,pi,data,footer,original,get disposed(){return disposed;},set compact(x){compact=x;}};
}
test('actual Pi footer renderer preserves every statistic/status but omits free provider prefix',()=>{
 const x=setup(),clean=s=>s.replace(/\x1b\[[0-9;]*m/g,'');const before=x.original.render(200).map(clean),after=x.footer.render(200).map(clean);
 assert.match(before[1],/\(free-zen\)/);assert.doesNotMatch(after[1],/free-zen/);assert.equal(after[0],before[0]);assert.equal(after[2],before[2]);
 for(const text of ['↑1.2k','↓543','R1.0k','W200','CH','42.0%','beam-free','low','$0.120'])assert.ok(after[1].includes(text),text);
 assert.equal(after[1].replaceAll(' ',''),before[1].replace('(free-zen)','').replaceAll(' ',''));
});
test('both free labels hidden, identity untouched, narrow width and compaction setting honored',()=>{
 const x=setup();x.ctx.model.provider='free-kilo';assert.doesNotMatch(x.footer.render(200).join('\n'),/free-kilo/);assert.equal(x.ctx.model.provider,'free-kilo');
 for(const width of [1,8,24,60,120])assert.ok(x.footer.render(width).every(line=>typeof line==='string'));
 x.compact=true;assert.match(x.footer.render(200).join('\n'),/auto/);x.footer.dispose();assert.equal(x.disposed,1);
});
test('controller claims only on explicit opt-in in TUI and supports opt-out',()=>{
 const calls=[],x=setup();let mode='compact';x.ctx.ui.setFooter=f=>calls.push(f);const update=footerController({pi:x.pi,getMode:()=>mode});
 x.ctx.mode='rpc';update(x.ctx);assert.equal(calls.length,0);x.ctx.mode='tui';update(x.ctx);assert.equal(calls.length,0);update(x.ctx,{claim:true});assert.equal(typeof calls[0],'function');update(x.ctx);assert.equal(calls.length,1);
 x.ctx.model={provider:'openai',id:'test'};update(x.ctx);assert.equal(calls[1],undefined);update(x.ctx);assert.equal(calls.length,2);
 x.ctx.model={provider:'free-zen',id:'beam-free'};update(x.ctx,{claim:true});mode='default';update(x.ctx);assert.equal(calls.at(-1),undefined);
});
test('foreign footer replacement is never cleared or reclaimed on model changes or default',()=>{
 const x=setup(),calls=[];let active,foreignDisposals=0,mode='compact';
 // Exercise Pi's actual slot replacement/disposal implementation, not a copied shim.
 const ui=Object.create(InteractiveMode.prototype);ui.ui={requestRender:()=>{}};ui.footerDataProvider=x.data;ui.footer={render:()=>['stock']};ui.footerContainer={clear:()=>{},addChild:()=>{}};
 x.ctx.ui.setFooter=f=>{ui.setExtensionFooter(f);active=ui.customFooter;calls.push(f);};
 const update=footerController({pi:x.pi,getMode:()=>mode});
 update(x.ctx,{claim:true});assert.ok(active);
 const foreign={render:()=>['other extension'],dispose:()=>foreignDisposals++};x.ctx.ui.setFooter(()=>foreign);
 const n=calls.length;x.ctx.model={provider:'openai',id:'other'};update(x.ctx);assert.equal(active,foreign);assert.equal(calls.length,n);
 x.ctx.model={provider:'free-zen',id:'beam-free'};update(x.ctx);assert.equal(active,foreign);assert.equal(calls.length,n);
 mode='default';update(x.ctx);assert.equal(active,foreign);assert.equal(foreignDisposals,0);
 mode='compact';update(x.ctx,{claim:true});assert.notEqual(active,foreign);assert.equal(foreignDisposals,1);active.dispose();
});
test('leaving a free model releases only an owned slot and never automatically reclaims it',()=>{
 const x=setup();let active,calls=0;const update=footerController({pi:x.pi,getMode:()=> 'compact'});
 x.ctx.ui.setFooter=f=>{active?.dispose?.();active=f?.({requestRender:()=>{}},null,x.data);calls++;};
 update(x.ctx,{claim:true});assert.ok(active);x.ctx.model={provider:'openai',id:'other'};update(x.ctx);assert.equal(active,undefined);
 x.ctx.model={provider:'free-zen',id:'beam-free'};update(x.ctx);assert.equal(active,undefined);assert.equal(calls,2);
});
