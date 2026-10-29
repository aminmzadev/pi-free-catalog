import { FreePool, freePoolDefaults, poolKey } from '../src/free-pool.js';
import { OvhPool } from '../src/ovh-pool.js';
import { state } from './helpers.mjs';
import { registrations } from '../src/models.js';
import { PROVIDERS, recordKey } from '../src/catalog.js';
export const K=recordKey('kilo','reflection/beam-free'),K2=recordKey('kilo','thinkingmachines/inkling-small:free'),A=recordKey('ovh','gpt-oss-120b'),B=recordKey('ovh','gpt-oss-20b');
export const context=()=>({messages:[{role:'user',content:[{type:'text',text:'Offline fixture'}],timestamp:1}],tools:[]});
export function environment({models=[K,K2],weights={},cycles=0,scheduling='auto',persist,synthetic=false}={}){
  let now=1000,disk,fail=false,sends=0;
  const catalog=synthetic?{state:{entries:{},sources:{}},assertUsable(service,id){const e=this.state.entries[recordKey(service,id)];if(!e||!e.listed)throw Error('Not eligible');return e;}}:{state:state(),assertUsable(service,id){const e=this.state.entries[recordKey(service,id)];if(!e||!e.listed||e.classification!=='free'||e.lifecycle==='retired')throw Error('Not eligible');return e;}};
  const ovh=new OvhPool({catalog,now:()=>now});
  const pool=new FreePool({catalog,ovhPool:ovh,file:'virtual',now:()=>now,persist:async(_file,value)=>{if(fail)throw Error('disk failure');if(persist)await persist(value);disk=structuredClone(value);},sleep:async ms=>{now+=ms;}});
  const all=synthetic?models.map((key,i)=>{const [service,id]=JSON.parse(key);catalog.state.entries[key]={service,id,type:'chat',listed:true,classification:'free',lifecycle:'active',metadata:{tool_call:true,context_length:65536,max_completion_tokens:4096}};return {provider:PROVIDERS[service],id,api:'openai-completions',type:'chat',contextWindow:65536,maxTokens:4096};}):Object.keys(PROVIDERS).flatMap(s=>registrations(catalog.state,s).map(m=>({...m,provider:PROVIDERS[s]})));
  if(synthetic)pool.eligible=()=>all.filter(m=>catalog.state.entries[poolKey(m)].listed);
  const model=key=>all.find(m=>poolKey(m)===key);
  return {pool,ovh,catalog,all,model,get disk(){return disk;},get now(){return now;},advance(ms){now+=ms;},setFail(v){fail=v;},get sends(){return sends;},
    async enable(extra={}){return pool.saveDraft({...freePoolDefaults(),enabled:true,models,weights,cycles,scheduling,...extra},pool.config,{restart:true,consent:true});},
    async next(source=model(models[0]),opts={}){const target=await pool.choose(source,context(),opts);await pool.reserve(target,()=>{});sends++;if(target.provider==='free-ovh')pool.started(target.id);return poolKey(target);},
  };
}
