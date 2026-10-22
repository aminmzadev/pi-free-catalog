import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Catalog,reconcile,recordKey} from '../src/catalog.js';
import {registrations,thinkingProfile} from '../src/models.js';
import {scopedFetch,requestPayload} from '../src/transport.js';
import {fixtures,fetcher,sources,state} from './helpers.mjs';
import {InteractiveMode} from '@earendil-works/pi-coding-agent';

test('elapsed time and compatibility ensureFresh never perform an automatic refresh',async()=>{
 let now=1,calls=0;const c=new Catalog({now:()=>now,fetch:async(...a)=>{calls++;return fetcher()(...a);}});
 await c.refresh();assert.equal(calls,7);now+=1000*60*60*24;
 await c.ensureFresh();c.assertUsable('zen','beam-free');assert.equal(calls,7);
 await c.refresh();assert.equal(calls,14);
});
test('disk cache survives a failed next-startup refresh and can send inference without a catalog fetch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'free-outage-'));
 try{
  const file=join(dir,'catalog.json'),a=new Catalog({file,fetch:fetcher()});await a.refresh();
  let attempts=0;const b=new Catalog({file,fetch:async()=>{attempts++;throw new Error('offline');}});await b.load();await b.refresh();
  assert.equal(attempts,7);assert.equal(registrations(b.state,'kilo').length,17);assert.equal(registrations(b.state,'zen').length,10);
  for(const service of ['kilo','zen']){
   const id=service==='kilo'?'reflection/beam-free':'beam-free';let sent=0;
   const body=await requestPayload({catalog:b,service,id,getSelection:()=> 'auto',piLevel:'low'})({model:id,messages:[]});
   const f=scopedFetch({catalog:b,service,model:{id},session:'ses_test',getFetch:()=>async()=>{sent++;return new Response('upstream missing',{status:404});}});
   const url=service==='kilo'?'https://api.kilo.ai/api/gateway/chat/completions':'https://opencode.ai/inference/v1/chat/completions';
   assert.equal((await f(url,{method:'POST',body:JSON.stringify(body)})).status,404);assert.equal(sent,1);
   assert.equal(b.assertUsable(service,id).classification,'free');
  }
  assert.equal(attempts,7);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('no cache plus no network does not invent free models or permit unknown requests',async()=>{
 const c=new Catalog({fetch:async()=>{throw new Error('offline');}});await c.refresh();
 assert.equal(registrations(c.state,'kilo').length,0);assert.equal(registrations(c.state,'zen').length,0);assert.throws(()=>c.assertUsable('zen','unknown'));
});
test('partial metadata outage keeps last-known Zen pricing instead of replacing it with unknown',()=>{
 const old=state(),d=structuredClone(fixtures);d.official.opencode.models['beam-free'].cost={};delete d.modelsdev.opencode.models['beam-free'];d.pi=d.pi.filter(x=>x.id!=='beam-free');
 const s=reconcile(sources(d),old),e=s.entries[recordKey('zen','beam-free')];assert.equal(e.classification,'free');assert.equal(e.fresh,false);assert.deepEqual(e.cost,old.entries[recordKey('zen','beam-free')].cost);assert.ok(registrations(s,'zen').some(x=>x.id==='beam-free'));
});
test('last-known free fallback never masks fresh paid/conflicting or explicit retired metadata',()=>{
 for(const scenario of ['paid','conflict','retired']){
  const d=structuredClone(fixtures),old=state();
  if(scenario==='paid'){d.official.opencode.models['beam-free'].cost={input:5,output:5};delete d.modelsdev.opencode.models['beam-free'];d.pi=d.pi.filter(x=>x.id!=='beam-free');}
  if(scenario==='conflict'){d.modelsdev.opencode.models['big-pickle'].cost={input:5,output:5};}
  if(scenario==='retired'){d.official.opencode.models['beam-free'].cost={};d.official.opencode.models['beam-free'].status='retired';}
  const s=reconcile(sources(d),old),c=new Catalog();c.state=s;assert.throws(()=>c.assertUsable('zen',scenario==='conflict'?'big-pickle':'beam-free'));
 }
});
test('cached Pi exact-ID API, compatibility and thinking hints remain usable during source outages',()=>{
 const s=state(),e=s.entries[recordKey('zen','beam-free')];e.metadata={...e.metadata};delete e.metadata.reasoning_options;delete e.metadata.thinkingLevelMap;
 s.sources.pi.fresh=false;s.sources.pi.data.push({id:'beam-free',api:'openai-responses',thinkingLevelMap:{low:'low',high:'high'},compat:{maxTokensField:'max_completion_tokens'}});
 s.sources.pi.data=s.sources.pi.data.filter((x,i,a)=>x.id!=='beam-free'||i===a.findLastIndex(y=>y.id==='beam-free'));
 const m=registrations(s,'zen').find(x=>x.id==='beam-free');assert.equal(m.api,'openai-responses');assert.equal(m.compat.maxTokensField,'max_completion_tokens');assert.ok(thinkingProfile(e,s).choices.low);
});
test('Pi actual compact-label formatter shows the package name for a root index entrypoint',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.deepEqual(pkg.pi.extensions,['./index.js']);
 const root=resolve('/tmp/package'),ui=Object.create(InteractiveMode.prototype),info={source:'npm:pi-free-catalog',scope:'user',baseDir:root};
 assert.equal(ui.getCompactExtensionLabel(join(root,'src/index.js'),info),'pi-free-catalog:src');
 assert.equal(ui.getCompactExtensionLabel(join(root,pkg.pi.extensions[0]),info),'pi-free-catalog');
 const loaded=await import('../index.js');assert.equal(typeof loaded.default,'function');
});
