import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import extension from '../src/index.js';import {fixtures,fetcher} from './helpers.mjs';
async function setup(fn){
 const dir=await mkdtemp(join(tmpdir(),'pi-free-extension-')),prior=process.env.PI_CODING_AGENT_DIR,original=globalThis.fetch;
 const configs=new Map(),commands=new Map(),events=new Map(),output=[];
 process.env.PI_CODING_AGENT_DIR=dir;let delegate=fetcher();globalThis.fetch=(...args)=>delegate(...args);const setFetch=fn=>{delegate=fn;};
 let thinking='medium';
 const pi={registerProvider:(id,c)=>configs.set(id,c),registerCommand:(id,c)=>commands.set(id,c),on:(id,fn)=>events.set(id,fn),sendMessage:m=>output.push(m.content),getThinkingLevel:()=>thinking,setThinkingLevel:level=>{const previousLevel=thinking;thinking=level;if(level!==previousLevel)void events.get('thinking_level_select')?.({level,previousLevel},ctx);}};
 const ctx={hasUI:false,model:{provider:'free-kilo',id:'poolside/laguna-s-2.1:free'},ui:{setStatus:()=>{}}};
 try{await extension(pi);await fn({dir,configs,commands,events,ctx,output,setFetch});}
 finally{globalThis.fetch=original;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true});}
}
test('real extension factory fetches at startup and registers both complete chat namespaces without a classifier dependency',async()=>setup(async({configs,commands})=>{
 assert.deepEqual([...configs.keys()],['free-kilo','free-ovh']);assert.equal(configs.get('free-kilo').models.length,17);assert.equal(configs.get('free-ovh').models.length,10);
 assert.equal(configs.get('free-kilo').classifiers,undefined);
 for(const command of ['free-catalog','free-refresh','free-thinking','free-export'])assert.ok(commands.has(command));
}));
test('real slash refresh replaces removed models but /free-catalog preserves visible history',async()=>setup(async({configs,commands,ctx,output,setFetch})=>{
 const d=structuredClone(fixtures);d.kilo.data=d.kilo.data.filter(m=>m.id!=='reflection/beam-free');setFetch(fetcher(d));
 await commands.get('free-refresh').handler('',ctx);assert.equal(configs.get('free-kilo').models.length,16);
 await commands.get('free-catalog').handler('',ctx);assert.match(output.at(-1),/reflection\/beam-free[\s\S]*Absent from the last successfully fetched provider-list snapshot/);
}));
test('interactive native thinking change persists and changes the ACTUAL SDK payload immediately',async()=>setup(async({dir,configs,commands,ctx,output})=>{
 await commands.get('free-thinking').handler('instant',ctx);const saved=JSON.parse(await readFile(join(dir,'free-catalog/thinking.json'),'utf8'));assert.equal(Object.values(saved)[0],'instant');
 let wire;const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/chat/completions')){wire=JSON.parse(init.body);return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"323"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}return original(input,init);};
 const config=configs.get('free-kilo'),model={...config.models.find(m=>m.id===ctx.model.id),provider:'free-kilo'};
 const stream=config.streamSimple(model,normalizeContext({messages:[{role:'user',content:'17 * 19',timestamp:1}]}),{reasoning:'medium',maxRetries:0});for await(const event of stream){};
 assert.equal((await stream.result()).stopReason,'stop');assert.deepEqual(wire.reasoning,{enabled:false,effort:'none'});
 await commands.get('free-thinking').handler('unsupported-made-up-mode',ctx);assert.match(output.at(-1),/Unsupported native/);assert.equal(JSON.parse(await readFile(join(dir,'free-catalog/thinking.json'),'utf8'))[JSON.stringify(['kilo',ctx.model.id])],'instant');
}));
test('export includes every live ID, sources, unknown/conflicts and retirement history',async()=>setup(async({dir,commands,ctx})=>{
 const target=join(dir,'export-test.json');await commands.get('free-export').handler(target,ctx);const data=JSON.parse(await readFile(target,'utf8'));
 assert.equal(Object.keys(data.sources).length,3);assert.equal(Object.values(data.entries).filter(e=>e.listed).length,422);assert.ok(Object.values(data.entries).some(e=>e.classification==='conflict'));assert.ok(data.history.length);
}));
test('production SDK imports use Pi public alias-safe entrypoints, not broken direct API subpaths',async()=>{
 const source=await readFile(new URL('../src/sdk.js',import.meta.url),'utf8');assert.ok(source.includes("from '@earendil-works/pi-ai/compat'"));assert.ok(!source.includes("providers/all"));assert.ok(!/from ['"]@earendil-works\/pi-ai\/api\//.test(source));
 const index=await readFile(new URL('../src/index.js',import.meta.url),'utf8');assert.ok(!/from ['"]@earendil-works\/pi-ai\/api\//.test(index));
});
