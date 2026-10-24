import { readFile, stat } from 'node:fs/promises';
import { atomicJSON, recordKey } from './catalog.js';
import { registrations, selectThinking } from './models.js';
import { clean } from './catalog-report.js';
import { cancellableDelay } from './ovh.js';
import { abortable, boundedErrorBody, cooldownEvidence, providerWide, retryAt } from './ovh-cooldown.js';
import { compatibility } from './ovh-pool-compat.js';
import { OvhQuota } from './ovh-quota.js';
const defaults=()=>({schemaVersion:1,enabled:false,models:[],maxWaitMs:0,responseStartTimeoutMs:0,thinking:{}});
export function distinctModels(ids){if(!Array.isArray(ids)||ids.some(s=>typeof s!=='string'||!s.trim()||s!==s.trim()||s.length>256))throw Error('Use exact nonempty OVH model IDs');return [...new Set(ids)];}
function validate(config){
 if(!config||config.schemaVersion!==1||typeof config.enabled!=='boolean'||!Number.isSafeInteger(config.maxWaitMs)||config.maxWaitMs<0||config.maxWaitMs>60000)throw Error('Invalid OVH pool configuration');
 const responseStartTimeoutMs=config.responseStartTimeoutMs===undefined?0:config.responseStartTimeoutMs;
 if(!Number.isSafeInteger(responseStartTimeoutMs)||responseStartTimeoutMs<0||responseStartTimeoutMs>300000)throw Error('Response-start limit must be 0 to 300 seconds');
 const models=distinctModels(config.models);if(models.length!==config.models.length||models.length>2000||(config.enabled&&models.length<2))throw Error('Invalid OVH pool selection');
 const thinking=config.thinking??{};
 if(!thinking||typeof thinking!=='object'||Array.isArray(thinking)||Object.entries(thinking).some(([id,mode])=>!models.includes(id)||typeof mode!=='string'||!mode.trim()||mode.length>128))throw Error('Invalid pool thinking configuration');
 return {schemaVersion:1,enabled:config.enabled,models,maxWaitMs:config.maxWaitMs,responseStartTimeoutMs,thinking:{...thinking}};
}
export class OvhPool {
 constructor({catalog,file,now=()=>Date.now(),sleep=cancellableDelay,persist=atomicJSON,getSelection=()=> 'auto',getPiLevel=()=> 'off',toolsRunning=()=>false}={}){
  Object.assign(this,{catalog,file,now,sleep,persist,getSelection,getPiLevel,toolsRunning});this.config=defaults();this.ready=new Map();this.confirmed=new Map();this.providerUntil=0;this.busy=null;this.changes=Promise.resolve();this.warning=null;this.shutdown=new AbortController();this.quota=new OvhQuota(now);
 }
 eligible(){return registrations(this.catalog.state,'ovh').filter(m=>{try{this.catalog.assertUsable('ovh',m.id);return m.type==='chat';}catch{return false;}});}
 usable(){const map=new Map(this.eligible().map(m=>[m.id,m]));return this.config.models.filter(id=>map.has(id));}
 manages(id){return this.config.enabled&&this.config.models.includes(id);}
 mode(id){return this.config.thinking[id]??this.getSelection('ovh',id);}
 close(){this.shutdown.abort(new DOMException('OVH pool shut down','AbortError'));}
 async load(){if(!this.file)return;try{if((await stat(this.file)).size>1048576)throw Error('Oversized config');this.config=validate(JSON.parse(await readFile(this.file,'utf8')));}catch(e){this.config=defaults();if(e.code!=='ENOENT')this.warning='OVH pool configuration is invalid; fallback is disabled.';}}
 async saveDraft(draft,expected=this.config){
  const requested=structuredClone(draft);
  const change=async()=>{
   if(this.config!==expected)throw Error('OVH pool changed while the editor was open');
   const c=validate(requested),eligible=new Set(this.eligible().map(m=>m.id));
   if(c.models.some(id=>!eligible.has(id)&&!expected.models.includes(id)))throw Error('Pool contains an ineligible model; reopen the editor');
   if(c.enabled&&!expected.enabled&&c.models.filter(id=>eligible.has(id)).length<2)throw Error('At least two selected models must currently be eligible to enable the pool');
   for(const [id,mode]of Object.entries(c.thinking))if(eligible.has(id)&&(mode!==expected.thinking[id]||!expected.models.includes(id)))selectThinking(this.catalog.state.entries[recordKey('ovh',id)],this.catalog.state,mode,mode==='auto'?undefined:this.getPiLevel());
   if(this.file)await this.persist(this.file,c);this.config=c;this.warning=null;return c;
  };
  const task=this.changes.then(change);this.changes=task.catch(()=>{});return task;
 }
 // Internal compatibility helpers, not public command editing paths.
 async configure(action,args=[]){
  const c=structuredClone(this.config);
  if(action==='set'){c.models=distinctModels(args);if(c.models.length<2)throw Error('Select at least two distinct eligible OVH chat models');c.thinking=Object.fromEntries(Object.entries(c.thinking).filter(([id])=>c.models.includes(id)));}
  else if(action==='on'&&!args.length){if(this.usable().length<2)throw Error('At least two selected models must be usable');c.enabled=true;}
  else if(action==='off'&&!args.length)c.enabled=false;
  else if(action==='clear'&&!args.length)Object.assign(c,defaults());
  else if(action==='wait'&&args.length===1&&/^\d+$/.test(args[0]))c.maxWaitMs=Number(args[0]);
  else throw Error('Open /free-ovh-pool to edit settings');
  return this.saveDraft(c);
 }
 async configureOptions(options,expected=this.config){
  const keys=options&&Object.keys(options).sort().join(',');
  if(!['enabled,maxWaitMs','enabled,maxWaitMs,responseStartTimeoutMs'].includes(keys))throw Error('Use enabled and maxWaitMs, with an optional response-start limit');
  return this.saveDraft({...expected,...options},expected);
 }
 report(){
  const usable=new Set(this.usable());
  return [`OVH pool: ${this.config.enabled?'ON':'OFF (default)'}`,
   `Selected: ${this.config.models.length}; eligible: ${usable.size}. Each request must fit the chosen model.`,
   `Wait for an available model: ${this.config.maxWaitMs/1000} seconds.`,
   `Response-start limit: ${this.config.responseStartTimeoutMs?this.config.responseStartTimeoutMs/1000+' seconds':'disabled'}.`,
   'Local readiness does not guarantee shared-IP capacity.',
   ...this.config.models.flatMap((id,i)=>{
    const q=this.quota.describe(id),ms=Math.max(this.ready.get(id)||0,this.providerUntil,q.readyInMs+this.now())-this.now();
    return [`${i+1}. ${clean(id)}`,`   ${usable.has(id)?'Eligible':'Unavailable'}; thinking: ${clean(this.mode(id))}`,
     `   ${ms>0?'Wait '+Math.ceil(ms/1000)+'s for quota':'Locally ready'}; slots left: ${q.remaining}`,`   Based on ${q.evidence}`];
   }),
   ...(this.lastCheck?['Latest check: '+clean(this.lastCheck)]:['Conversation fit has not been checked yet.']),
   ...(this.warning?[clean(this.warning)]:[])].join('\n');
 }
 started(id){this.quota.started(id);}
 networkFailure(id){this.confirmed.delete(id);this.quota.failed(id);}
 async observe(id,response,{signal,url=response.url}={}){
  const entry=this.catalog.state.entries[recordKey('ovh',id)];
  this.quota.observe(id,response,{url,entitlement:entry?.metadata?.ovh?.anonymousRateLimit});
  if(response.status!==429){this.confirmed.delete(id);return;}
  const now=this.now(),body=await boundedErrorBody(response,{signal}),at=retryAt(response.headers.get('retry-after'),now)??now+61000;
  this.ready.set(id,Math.max(this.ready.get(id)||0,at));
  const e=cooldownEvidence(id,response.status,response.headers,body,now,{url:response.redirected?undefined:url,model:entry?.id,anonymousRateLimit:entry?.metadata?.ovh?.anonymousRateLimit});
  if(providerWide(response.status,response.headers,body)){this.providerUntil=Math.max(this.providerUntil,at);this.confirmed.clear();}
  else if(e){this.confirmed.set(id,e.until);this.ready.set(id,Math.max(this.ready.get(id)||0,e.until));}
  else this.confirmed.delete(id);
 }
 async waitUnmanaged(id,{signal,onWait}={}){
  // OFF/unselected traffic keeps legacy pacing, but must not forget quota
  // already consumed while the pool was ON or a server Retry-After barrier.
  for(;;){
   if(signal?.aborted)throw signal.reason;
   const ms=Math.max(this.ready.get(id)||0,this.confirmed.get(id)||0,this.providerUntil,this.quota.until(id))-this.now();
   if(ms<=0)return;onWait?.(ms);try{await this.sleep(ms,signal);}finally{onWait?.(0);}
  }
 }
 assertSlot(id){
  const until=Math.max(this.ready.get(id)||0,this.confirmed.get(id)||0,this.providerUntil,this.quota.until(id));
  if(until>this.now())throw Error('OVH quota slot changed before HTTP; no request was sent. Retry in '+Math.ceil((until-this.now())/1000)+'s.');
 }
 async acquire(signal){
  if(this.busy){if(!this.config.maxWaitMs)throw Error('OVH pool request is already active; no concurrent handoff');await abortable(this.busy,signal);return this.acquire(signal);}
  let release;this.busy=new Promise(r=>release=r);return ()=>{this.busy=null;release();};
 }
 reason(source,target,context,options){return compatibility({catalog:this.catalog,source,target,context,options,getSelection:(_s,id)=>this.mode(id),piLevel:this.getPiLevel(),toolsRunning:this.toolsRunning()});}
 async choose(source,context,options,signal,onDecision,onWait=this.onWait){
  if(!this.manages(source.id))return source;
  while(true){
   if(signal?.aborted)throw signal.reason;
   if(!this.manages(source.id))throw Error('OVH pool changed while waiting; retry explicitly');
   const now=this.now();
   if(this.providerUntil>now){await this.wait(this.providerUntil-now,signal,'Provider-wide OVH limit',onWait);continue;}
   const available=new Map(this.eligible().map(m=>[m.id,{...m,provider:'free-ovh'}]));
   const sourceReason=this.reason(source,source,context,options);
   const triggered=(this.confirmed.get(source.id)||0)>now||this.quota.exhausted(source.id)||!!sourceReason;
   const rank=this.config.models.indexOf(source.id);
   const candidates=triggered?this.config.models:this.config.models.slice(0,rank+1);
   let earliest=Infinity;const reasons=[];
   for(const id of candidates){
    const target=available.get(id);if(!target){reasons.push(id+': unavailable');onDecision?.(id,'unavailable');continue;}
    const reason=this.reason(source,target,context,options);
    if(reason){reasons.push(id+': '+reason);onDecision?.(id,'not-compatible');continue;}
    const until=Math.max(this.ready.get(id)||0,this.confirmed.get(id)||0,this.quota.until(id));
    if(until<=now){this.lastCheck=`${id} ready and compatible${reasons.length?'; skipped '+reasons.join('; '):''}`;return id===source.id?source:target;}
    onDecision?.(id,'cooling');
    reasons.push(id+': quota-limited for '+Math.ceil((until-now)/1000)+'s');earliest=Math.min(earliest,until);
   }
   this.lastCheck=reasons.join('; ');
   if(!Number.isFinite(earliest))throw Error('No compatible selected OVH model: '+reasons.join('; '));
   await this.wait(earliest-now,signal,'No permitted compatible OVH model is ready: '+reasons.join('; '),onWait);
  }
 }
 /** Only the explicit silent-start deadline may call this; never wait/probe a cooling candidate. */
 chooseAfterTimeout(source,context,options,signal,attempted,onDecision){
  if(signal?.aborted)throw signal.reason;
  if(!this.manages(source.id))throw Error('OVH pool changed; no further request was sent');
  if(this.providerUntil>this.now())throw Error('Provider-wide OVH limit; no further request was sent');
  const available=new Map(this.eligible().map(m=>[m.id,{...m,provider:'free-ovh'}]));
  const reasons=[];
  for(const id of this.config.models.slice(this.config.models.indexOf(source.id)+1)){
   if(attempted.has(id))continue;
   const target=available.get(id);
   let state,reason;
   if(!target){state='unavailable';reason='unavailable';}
   else if((reason=this.reason(source,target,context,options))){state='not-compatible';}
   else if(Math.max(this.ready.get(id)||0,this.confirmed.get(id)||0,this.quota.until(id))>this.now()){
    state='cooling';reason='waiting for quota';
   }
   if(state){reasons.push(id+': '+reason);onDecision?.(id,state);continue;}
   this.lastCheck=id+' ready after response-start timeout'+(reasons.length?'; skipped '+reasons.join('; '):'');
   return target;
  }
  this.lastCheck=reasons.join('; ');
  throw Error('OVH pool exhausted after response-start timeout: '+attempted.size+' model(s) tried once; no later selected model is ready and compatible.'+(reasons.length?' '+reasons.join('; '):''));
 }
 async wait(ms,signal,reason,onWait=this.onWait){
  if(!this.config.maxWaitMs)throw Error(reason+'. Local wait is disabled; open /free-ovh-pool to change it. No HTTP request was sent.');
  onWait?.(ms);try{await abortable(this.sleep(ms,signal),signal);}finally{onWait?.(0);}
 }
}
