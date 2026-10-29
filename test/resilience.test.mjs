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
 await c.refresh();assert.equal(calls,3);now+=1000*60*60*24;
 await c.ensureFresh();c.assertUsable('kilo','thinkingmachines/inkling-small:free');assert.equal(calls,3);
 await c.refresh();assert.equal(calls,6);
});
test('disk cache survives a failed next-startup refresh and can send inference without a catalog fetch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'free-outage-'));
 try{
  const file=join(dir,'catalog.json'),a=new Catalog({file,fetch:fetcher()});await a.refresh();
  let attempts=0;const b=new Catalog({file,fetch:async()=>{attempts++;throw new Error('offline');}});await b.load();await b.refresh();
  assert.equal(attempts,3);assert.equal(registrations(b.state,'kilo').length,17);assert.equal(registrations(b.state,'ovh').length,10);
  for(const service of ['kilo']){
   const id=service==='kilo'?'reflection/beam-free':'thinkingmachines/inkling-small:free';let sent=0;
   const body=await requestPayload({catalog:b,service,id,getSelection:()=> 'auto',piLevel:'low'})({model:id,messages:[]});
   const f=scopedFetch({catalog:b,service,model:{id},session:'ses_test',getFetch:()=>async()=>{sent++;return new Response('upstream missing',{status:404});}});
   const url='https://api.kilo.ai/api/gateway/chat/completions';
   assert.equal((await f(url,{method:'POST',body:JSON.stringify(body)})).status,404);assert.equal(sent,1);
   assert.equal(b.assertUsable(service,id).classification,'free');
  }
  assert.equal(attempts,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('no cache plus no network does not invent free models or permit unknown requests',async()=>{
 const c=new Catalog({fetch:async()=>{throw new Error('offline');}});await c.refresh();
 assert.equal(registrations(c.state,'kilo').length,0);assert.equal(registrations(c.state,'kilo').length,0);assert.throws(()=>c.assertUsable('kilo','unknown'));
});

test('last-known free fallback never masks fresh paid/conflicting or explicit retired metadata',()=>{
 for(const scenario of ['paid','conflict','retired']){
  const d=structuredClone(fixtures),old=state();
  const row=d.kilo.data.find(m=>m.id===(scenario==='conflict'?'kilo-auto/free':'thinkingmachines/inkling-small:free'));
  if(scenario==='paid'){row.isFree=false;row.pricing={prompt:5,completion:5};}
  if(scenario==='conflict'){row.isFree=true;row.pricing={prompt:5,completion:5};}
  if(scenario==='retired'){row.status='retired';}
  const s=reconcile(sources(d),old),c=new Catalog();c.state=s;assert.throws(()=>c.assertUsable('kilo',scenario==='conflict'?'kilo-auto/free':'thinkingmachines/inkling-small:free'));
 }
});

test('Pi actual compact-label formatter shows the package name for a root index entrypoint',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.deepEqual(pkg.pi.extensions,['./index.js']);
 const root=resolve('/tmp/package'),ui=Object.create(InteractiveMode.prototype),info={source:'npm:pi-free-catalog',scope:'user',baseDir:root};
 assert.equal(ui.getCompactExtensionLabel(join(root,'src/index.js'),info),'pi-free-catalog:src');
 assert.equal(ui.getCompactExtensionLabel(join(root,pkg.pi.extensions[0]),info),'pi-free-catalog');
 const loaded=await import('../index.js');assert.equal(typeof loaded.default,'function');
});
