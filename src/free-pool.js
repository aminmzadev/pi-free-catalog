import { readFile, stat } from 'node:fs/promises';
import { migratePoolProvider } from './provider-removal.js';
import { atomicJSON, PROVIDERS, recordKey } from './catalog.js';
import { registrations, selectThinking } from './models.js';
import { clean } from './catalog-report.js';
import { cancellableDelay } from './ovh.js';
import { abortable, retryAt } from './ovh-cooldown.js';
import { freeCompatibility } from './free-pool-compat.js';
import { MAX_COOLDOWN_EVIDENCE, readCooldownEvidence, cooldownEvidenceText, compatibilityCode, iso } from './free-pool-diagnostics.js';

export function poolKey(model) {
  const service = Object.keys(PROVIDERS).find(s => PROVIDERS[s] === model?.provider);
  if (!service) throw Error('Unknown free provider');
  return recordKey(service, model.id);
}
export function parsePoolKey(key) {
  let row; try { row = JSON.parse(key); } catch { throw Error('Invalid pool model identity'); }
  if (!Array.isArray(row) || row.length !== 2 || !Object.hasOwn(PROVIDERS,row[0]) || typeof row[1] !== 'string' ||
      !row[1].trim() || row[1] !== row[1].trim() || row[1].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(row[1]) || recordKey(...row) !== key) throw Error('Invalid pool model identity');
  return { service:row[0], id:row[1], provider:PROVIDERS[row[0]] };
}
export const freePoolDefaults = () => ({ schemaVersion:2, enabled:false, models:[], thinking:{}, weights:{}, scheduling:'auto', cycles:0, maxWaitMs:0, responseStartTimeoutMs:0 });
export const rotationDefaults = () => ({ cursor:0, used:0, completed:0, paused:false });
export function schedulingMode(config) { return config.scheduling === 'auto' ? (config.models.some(k => parsePoolKey(k).service === 'ovh') ? 'priority' : 'round-robin') : config.scheduling; }
export function validateFreePool(raw) {
  const c={...freePoolDefaults(),...raw};
  if (!raw || raw.schemaVersion!==2 || typeof c.enabled!=='boolean' || !Array.isArray(c.models) || c.models.length>2000 || new Set(c.models).size!==c.models.length || (c.enabled&&c.models.length<2)) throw Error('Select at least two distinct free chat models to enable the pool');
  for (const k of c.models) parsePoolKey(k);
  for (const [key,max] of [['maxWaitMs',60000],['responseStartTimeoutMs',300000],['cycles',10000]]) if (!Number.isSafeInteger(c[key])||c[key]<0||c[key]>max) throw Error('Invalid pool duration or cycle allowance');
  if (!['auto','priority','round-robin'].includes(c.scheduling)) throw Error('Invalid scheduling mode');
  if(c.cycles&&schedulingMode(c)!=='round-robin')throw Error('Finite cycles require round-robin scheduling');
  const weights={},thinking={};
  for(const field of ['weights','thinking']) if(!c[field]||typeof c[field]!=='object'||Array.isArray(c[field])||Object.keys(c[field]).some(k=>!c.models.includes(k))) throw Error('Invalid per-model settings');
  for (const k of c.models) {
    const ovh=parsePoolKey(k).service==='ovh', w=c.weights[k]??(ovh?2:1), mode=c.thinking[k]??'default';
    if (!Number.isSafeInteger(w)||w<1||w>(ovh?2:100)) throw Error(ovh?'OVH requests per visit must be 1 or 2':'Requests per visit must be 1 to 100');
    if(typeof mode!=='string'||!mode.trim()||mode.length>128)throw Error('Invalid native thinking setting');
    weights[k]=w;thinking[k]=mode;
  }
  return Object.freeze({schemaVersion:2,enabled:c.enabled,models:Object.freeze([...c.models]),weights:Object.freeze(weights),thinking:Object.freeze(thinking),scheduling:c.scheduling,cycles:c.cycles,maxWaitMs:c.maxWaitMs,responseStartTimeoutMs:c.responseStartTimeoutMs});
}
function validateRotation(raw,c) {
  if(!raw||typeof raw.paused!=='boolean'||!['cursor','used','completed'].every(k=>Number.isSafeInteger(raw[k])&&raw[k]>=0)||
    raw.cursor>=Math.max(1,c.models.length)||raw.used>=(c.weights[c.models[raw.cursor]]??1)||raw.completed>1000000000||
    (c.cycles&&raw.completed>c.cycles)||(c.cycles&&raw.completed===c.cycles&&!raw.paused)) throw Error('Invalid persisted rotation; explicit restart required');
  return Object.freeze({cursor:raw.cursor,used:raw.used,completed:raw.completed,paused:raw.paused});
}
export class FreePool {
  constructor({catalog,file,ovhPool,now=()=>Date.now(),sleep=cancellableDelay,persist=atomicJSON,getPiLevel=()=> 'off',toolsRunning=()=>false}={}) {
    Object.assign(this,{catalog,file,ovhPool,now,sleep,persist,getPiLevel,toolsRunning});
    this.config=validateFreePool(freePoolDefaults());this.rotation=Object.freeze(rotationDefaults());this.installed=false;this.label='Free';this.scope='free';
    this.shutdown=new AbortController();this.changes=Promise.resolve();this.busy=null;this.barriers=new Map();this.modelBarriers=new Map();this.ovhReservations={};this.ovhCooldowns={models:{},providerUntil:0};this.warning=null;this.cooldownEvidence=[];this.diagnosticWarning=null;
  }
  key(model){return poolKey(model);}
  mode(key){return this.config.thinking[key]??'default';}
  manages(key){return this.config.enabled&&this.config.models.includes(key);}
  eligible(){return Object.keys(PROVIDERS).flatMap(s=>registrations(this.catalog.state,s).filter(m=>{try{this.catalog.assertUsable(s,m.id);return m.type==='chat'&&['openai-completions','openai-responses'].includes(m.api);}catch{return false;}}).map(m=>({...m,provider:PROVIDERS[s]})));}
  unsupported(){return Object.keys(PROVIDERS).flatMap(service=>registrations(this.catalog.state,service).filter(m=>m.type==='chat'&&!['openai-completions','openai-responses'].includes(m.api)).map(m=>`${PROVIDERS[service]}/${m.id}: ${m.api} is not verified through the unchanged anonymous route guard (Pi 1.4 Anthropic adds a beta query).`));}
  usable(){const keys=new Set(this.eligible().map(poolKey));return this.config.models.filter(k=>keys.has(k));}
  importLegacy(){
    if(this.installed)return;
    const c=this.ovhPool.config;
    this.config=validateFreePool({...freePoolDefaults(),enabled:c.enabled,models:c.models.map(id=>recordKey('ovh',id)),thinking:Object.fromEntries(c.models.map(id=>[recordKey('ovh',id),this.ovhPool.mode(id)])),scheduling:c.models.length?'priority':'auto',maxWaitMs:c.maxWaitMs,responseStartTimeoutMs:c.responseStartTimeoutMs});
  }
  async load(){
    if(!this.file)return;
    try {
      if((await stat(this.file)).size>1048576)throw Error('Oversized free pool file');
      this.installed=true;const migration=migratePoolProvider(JSON.parse(await readFile(this.file,'utf8')));const raw=migration.value;
      if(raw.removalReviewRequired!==undefined&&typeof raw.removalReviewRequired!=='boolean')throw Error('Invalid removal review state');
      this.removalReviewRequired=!!raw.removalReviewRequired;
      if(raw.schemaVersion!==2)throw Error('Unsupported free pool schema');
      this.config=validateFreePool(raw.config);
      const services=[...new Set(this.config.models.map(k=>parsePoolKey(k).service))].sort();
      if(JSON.stringify(raw.approvedProviders)!==JSON.stringify(services))throw Error('Provider routing consent does not match selection');
      try { this.cooldownEvidence=readCooldownEvidence(raw.cooldownEvidence); }
      catch { this.diagnosticWarning='Saved cooldown evidence is invalid; enforcement is unchanged and its origin may be unknown.'; }
      let validRuntime=true;
      try {
        if(raw.policyVersion!==undefined&&raw.policyVersion!==3)throw Error('Unsupported pool policy version');
        if(raw.policyVersion===3&&(!raw.modelBarriers||typeof raw.modelBarriers!=='object'||Array.isArray(raw.modelBarriers)))throw Error('Missing model cooldown state');
        for(const [key,b] of Object.entries(raw.modelBarriers??{})){if(!['kilo'].includes(parsePoolKey(key).service)||!Number.isSafeInteger(b?.until)||b.until<0)throw Error('Invalid saved model cooldown');this.modelBarriers.set(key,{until:b.until});}
        if(!raw.barriers||typeof raw.barriers!=='object'||Array.isArray(raw.barriers)||!raw.ovhReservations||typeof raw.ovhReservations!=='object'||Array.isArray(raw.ovhReservations))throw Error('Missing durable cooldown state');
        for(const [service,b] of Object.entries(raw.barriers)){if(!['kilo'].includes(service)||!Number.isSafeInteger(b?.until)||b.until<0)throw Error('Invalid saved cooldown');this.barriers.set(service,{until:b.until});}
        for(const [id,times] of Object.entries(raw.ovhReservations)){if(!Array.isArray(times)||times.length>2||times.some(t=>!Number.isSafeInteger(t)||t<0))throw Error('Invalid OVH reservations');}
        if(!raw.ovhCooldowns||!Number.isSafeInteger(raw.ovhCooldowns.providerUntil)||raw.ovhCooldowns.providerUntil<0||!raw.ovhCooldowns.models||typeof raw.ovhCooldowns.models!=='object'||Array.isArray(raw.ovhCooldowns.models)||Object.values(raw.ovhCooldowns.models).some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid saved OVH cooldown');
        this.ovhCooldowns=raw.ovhCooldowns;
        this.ovhReservations=raw.ovhReservations;
        this.rotation=validateRotation(raw.rotation,this.config);}catch(e){validRuntime=false;this.rotation=Object.freeze({...rotationDefaults(),paused:true});this.warning=e.message;}
      if(raw.policyVersion===undefined){
        // This build carries the user's explicit choice: continuous scheduling and
        // no blanket Kilo gates inferred by the old package policy.
        const oldConfig=this.config,oldRotation=this.rotation;
        for(const e of this.cooldownEvidence){
          if(e.service==='ovh')continue;
          const key=recordKey(e.service,e.model);
          this.modelBarriers.set(key,{until:Math.max(this.modelBarriers.get(key)?.until??0,e.until)});
        }
        this.barriers.clear();
        this.cooldownEvidence=this.cooldownEvidence.map(e=>e.service==='ovh'?e:Object.freeze({...e,scope:'model'}));
        if(validRuntime){
        const exhausted=oldConfig.cycles>0&&oldRotation.completed>=oldConfig.cycles;
        this.config=validateFreePool({...oldConfig,cycles:0});
        this.rotation=Object.freeze({...oldRotation,paused:exhausted?false:oldRotation.paused});
        this.policyNotice='Continuity update: the user requested continuous scheduling. Old finite-cycle exhaustion was removed; OVH quota remains unchanged. Legacy blanket Kilo policy gates were reassigned to known originating models; gates with no recoverable origin were retired, not guessed onto every model.';
        try{await this.store(this.config,this.rotation);}catch(e){this.rotation=Object.freeze({...this.rotation,paused:true});this.warning='Could not persist the continuity policy update; managed requests are paused. Repair storage and reload. '+clean(e.message);}
        }
      }
      if(this.removalReviewRequired){this.config=validateFreePool({...this.config,enabled:false});this.rotation=Object.freeze({...this.rotation,paused:true});this.warning='A removed provider was retired from this pool. Remaining settings, cooldowns and quotas were preserved. Review and explicitly restart before enabling.';}
      if(migration.changed&&validRuntime)await this.store(this.config,this.rotation);
    }catch(e){
      if(e.code==='ENOENT')return;
      this.installed=true;this.config=validateFreePool(freePoolDefaults());this.rotation=Object.freeze({...rotationDefaults(),paused:true});this.warning='Free pool disabled: invalid saved settings. Review and Apply explicitly. '+clean(e.message);
    }
  }
  async store(config,rotation){
    const value={schemaVersion:2,policyVersion:3,...(this.removalReviewRequired?{removalReviewRequired:true}:{}),modelBarriers:Object.fromEntries(this.modelBarriers),config,rotation,cooldownEvidence:this.cooldownEvidence,barriers:Object.fromEntries(this.barriers),ovhCooldowns:this.ovhCooldowns,ovhReservations:this.ovhReservations,approvedProviders:[...new Set(config.models.map(k=>parsePoolKey(k).service))].sort()};
    if(Buffer.byteLength(JSON.stringify(value))>1048576)throw Error('Free pool settings exceed the safe file size limit');
    if(this.file)await this.persist(this.file,value);
  }
  enqueue(task){const p=this.changes.then(task);this.changes=p.catch(()=>{});return p;}
  async saveDraft(draft,expected=this.config,{restart=false,consent=false}={}){
    const requested=structuredClone(draft);
    return this.enqueue(async()=>{
      if(this.shutdown.signal.aborted||this.busy)throw Error('Pool is busy or closed');
      if(this.config!==expected)throw Error('Pool changed while editing; reopen settings');
      if(this.removalReviewRequired&&(!restart||!consent))throw Error('Review and explicitly restart the migrated pool before changing it');
      const c=validateFreePool(requested),eligible=new Map(this.eligible().map(m=>[poolKey(m),m]));
      if(c.models.some(k=>!eligible.has(k)&&!expected.models.includes(k)))throw Error('New selection is no longer eligible');
      if(c.enabled&&!expected.enabled&&c.models.filter(k=>eligible.has(k)).length<2)throw Error('Two selected models must be eligible to enable the pool');
      for(const k of c.models)if(eligible.has(k))selectThinking(this.catalog.state.entries[k],this.catalog.state,c.thinking[k],this.getPiLevel());
      const structural=['models','weights','scheduling','cycles'].some(k=>JSON.stringify(c[k])!==JSON.stringify(expected[k]));
      if((structural||!this.installed)&&!restart)throw Error('Review and explicitly restart the rotation for this change');
      if(!consent&&(!this.installed||JSON.stringify(c.models)!==JSON.stringify(expected.models)))throw Error('Explicit provider routing consent is required');
      const r=restart?Object.freeze(rotationDefaults()):this.rotation;
      const priorReservations=this.ovhReservations,priorCooldowns=this.ovhCooldowns;
      if(!this.installed){
        this.ovhReservations={...priorReservations};
        const ready={...priorCooldowns.models};
        for(const key of c.models){const {service,id}=parsePoolKey(key);if(service!=='ovh')continue;
          const remaining=this.ovhPool.quota.describe(id).remaining;
          if(Number.isInteger(remaining)&&remaining<2)this.ovhReservations[id]=Array.from({length:2-remaining},()=>this.now());
          const until=Math.max(this.ovhPool.ready.get(id)||0,this.ovhPool.confirmed.get(id)||0,this.ovhPool.quota.until(id));
          if(until>this.now())ready[id]=until;
        }
        this.ovhCooldowns={models:ready,providerUntil:Math.max(priorCooldowns.providerUntil,this.ovhPool.providerUntil)};
      }
      const priorReview=this.removalReviewRequired;this.removalReviewRequired=false;
      try{await this.store(c,r);}catch(e){this.removalReviewRequired=priorReview;this.ovhReservations=priorReservations;this.ovhCooldowns=priorCooldowns;throw e;}this.config=c;this.rotation=r;this.installed=true;this.warning=null;return c;
    });
  }
  close(){this.shutdown.abort(new DOMException('Free pool shut down','AbortError'));}
  async acquire(signal){
    if(this.busy){if(!this.config.maxWaitMs)throw Error('Free pool is already processing a request');await abortable(this.busy,signal);return this.acquire(signal);}
    let done;this.busy=new Promise(r=>done=r);return()=>{this.busy=null;done();};
  }
  reason(source,target,context,options){return freeCompatibility({catalog:this.catalog,source,target,context,options,mode:this.mode(poolKey(target)),piLevel:this.getPiLevel(),toolsRunning:this.toolsRunning()});}
  until(key){const {service,id}=parsePoolKey(key);return service==='ovh'?Math.max(this.ovhCooldowns.providerUntil,Object.hasOwn(this.ovhCooldowns.models,id)?this.ovhCooldowns.models[id]:0,this.durableOvhUntil(id),this.ovhPool.ready.get(id)||0,this.ovhPool.confirmed.get(id)||0,this.ovhPool.providerUntil,this.ovhPool.quota.until(id)):Math.max(this.barriers.get(service)?.until??0,this.modelBarriers.get(recordKey(service,id))?.until??0);}
  durableOvhUntil(id){const times=(Object.hasOwn(this.ovhReservations,id)?this.ovhReservations[id]:[]).filter(t=>t+60000>this.now());return times.length>=2?Math.min(...times)+60000:0;}
  async waitUnmanaged(id,{signal,onWait}={},service='ovh'){
    for(;;){
      if(signal?.aborted)throw signal.reason;
      const ms=this.until(recordKey(service,id))-this.now();
      if(ms<=0)return;
      onWait?.(ms);try{await abortable(this.sleep(ms,signal),signal);}finally{onWait?.(0);}
    }
  }
  assertSlot(id,service='ovh'){const until=this.until(recordKey(service,id));if(until>this.now())throw Error('Free pool cooldown changed before HTTP; no request was sent');}
  advance(r,c=this.config){
    r.used=0;r.cursor++;
    if(r.cursor>=c.models.length){r.cursor=0;r.completed=Math.min(1000000000,r.completed+1);if(c.cycles&&r.completed>=c.cycles)r.paused=true;}
  }
  async persistRotation(next){
    try{await this.store(this.config,next);this.rotation=Object.freeze(next);}
    catch(e){this.rotation=Object.freeze({...this.rotation,paused:true});this.warning='Could not save rotation. No new request was sent; repair storage and explicitly restart.';throw Error(this.warning,{cause:e});}
  }
  /** Reserve durably before the wire. A crash/cancel can underuse a visit, never grant it twice. */
  async reserve(model,check){
    return this.enqueue(async()=>{
      if(this.shutdown.signal.aborted)throw this.shutdown.signal.reason;
      check();if(this.rotation.paused)throw Error('Free pool paused; review and restart the rotation');
      const key=poolKey(model),index=this.config.models.indexOf(key);if(index<0)throw Error('Target removed from pool');
      const r={...this.rotation};
      if(schedulingMode(this.config)==='round-robin'&&index!==r.cursor)throw Error('Rotation position changed before dispatch');
      if(r.cursor!==index)r.used=0;
      r.cursor=index;r.used++;
      const parsed=parsePoolKey(key),previous=this.ovhReservations;
      if(parsed.service==='ovh'){
        this.assertSlot(parsed.id,'ovh');
        this.ovhReservations={...previous,[parsed.id]:[...(Object.hasOwn(previous,parsed.id)?previous[parsed.id]:[]).filter(t=>t+60000>this.now()),this.now()]};
      }
      if(r.used>=this.config.weights[key])this.advance(r);
      try{await this.persistRotation(r);}catch(e){this.ovhReservations=previous;throw e;}
      check();
    });
  }
  async choose(source,context,options,signal,onDecision,onWait){
    if(this.shutdown.signal.aborted)throw this.shutdown.signal.reason;
    if(!this.manages(poolKey(source)))return source;
    for(;;){
      if(signal?.aborted)throw signal.reason;
      if(this.rotation.paused)throw this.pauseError();
      const map=new Map(this.eligible().map(m=>[poolKey(m),m]));let earliest=Infinity;const reasons=[];
      const rr=schedulingMode(this.config)==='round-robin';let r={...this.rotation};
      for(let n=0;n<this.config.models.length;n++){
        const key=this.config.models[rr?r.cursor:n],target=map.get(key);
        const reason=target?this.reason(source,target,context,options):'Unavailable';
        if(!reason&&this.until(key)<=this.now()){
          if(rr&&JSON.stringify(r)!==JSON.stringify(this.rotation))await this.enqueue(()=>this.persistRotation(r));
          this.selectionCheck(`${key}: ready; request ${r.used+1}/${this.config.weights[key]} this visit`);
          return key===poolKey(source)?source:target;
        }
        const status=reason?(target?'not-compatible':'unavailable'):'cooling';onDecision?.(key,status,reason?compatibilityCode(reason):'cooldown');reasons.push(key+': '+(reason||'cooling down'));
        if(!reason)earliest=Math.min(earliest,this.until(key));
        if(rr){this.advance(r);if(r.paused)break;}
      }
      this.selectionCheck(reasons.join('; '));
      if(rr&&JSON.stringify(r)!==JSON.stringify(this.rotation))await this.enqueue(()=>this.persistRotation(r));
      if(this.rotation.paused)throw this.pauseError();
      if(!Number.isFinite(earliest))throw this.failureError('no-compatible-model','No ready compatible free model [no-compatible-model]. No selected model is eligible and compatible with this request. '+this.lastCheck);
      if(!this.config.maxWaitMs)throw this.failureError('cooldown-active','No ready compatible free model [cooldown-active]. Readiness wait is OFF; compatible models have active cooldowns. '+this.lastCheck);
      onWait?.(Math.max(1,earliest-this.now()));try{await abortable(this.sleep(Math.max(1,earliest-this.now()),signal),signal);}finally{onWait?.(0);}
    }
  }
  /** Owned timeout selection; general mode separately authorizes pre-activity HTTP 429. */
  chooseAfterTimeout(source,context,options,signal,attempted,onDecision){
    if(signal?.aborted)throw signal.reason;
    if(this.rotation.paused)throw this.pauseError();
    const map=new Map(this.eligible().map(m=>[poolKey(m),m])),start=this.config.models.indexOf(poolKey(source));
    // Priority visits only later entries; RR can wrap but never resend an identity.
    const ids=schedulingMode(this.config)==='round-robin'?[...this.config.models.slice(start+1),...this.config.models.slice(0,start)]:this.config.models.slice(start+1);
    // Reserve is tied to the cursor: selection of skipped visits must be persisted asynchronously.
    return this.afterTimeoutSelection(ids,map,source,context,options,signal,attempted,onDecision);
  }
  chooseAfterRateLimit(source,context,options,signal,attempted,onDecision){
    if(signal?.aborted)throw signal.reason;
    if(this.rotation.paused)throw this.pauseError();
    const models=this.config.models,start=models.indexOf(poolKey(source));
    const ids=[...models.slice(start+1),...models.slice(0,start)];
    const map=new Map(this.eligible().map(m=>[poolKey(m),m]));
    return this.afterTimeoutSelection(ids,map,source,context,options,signal,attempted,onDecision,'rate-limit');
  }
  async afterTimeoutSelection(ids,map,source,context,options,signal,attempted,onDecision,kind='timeout'){
    for(const key of ids){
      if(attempted.has(key))continue;const target=map.get(key),reason=target?this.reason(source,target,context,options):'Unavailable';
      if(reason||this.until(key)>this.now()){onDecision?.(key,reason?'not-compatible':'cooling',reason?compatibilityCode(reason):'cooldown');continue;}
      if(signal?.aborted)throw signal.reason;
      if(schedulingMode(this.config)==='round-robin'){
        const r={...this.rotation};
        if(this.config.models[r.cursor]!==key){
          // End the timed-out visit, then walk forward, charging no phantom sends.
          for(let n=0;n<this.config.models.length&&this.config.models[r.cursor]!==key&&!r.paused;n++)this.advance(r);
        }
        if(r.paused)throw this.pauseError();
        if(JSON.stringify(r)!==JSON.stringify(this.rotation))await this.enqueue(()=>this.persistRotation(r));
      }
      return target;
    }
    if(kind==='rate-limit')throw this.failureError('rate-limit-exhausted','Free pool: HTTP 429 was received, but no untried ready compatible model remains. The pool is not disabled; active cooldowns must expire before later requests.');
    throw this.failureError('response-start-exhausted','Free pool exhausted after response-start timeout; no untried compatible model is ready');
  }
  started(id,service='ovh'){if(service==='ovh')this.ovhPool.started(id);}
  networkFailure(id,service='ovh'){if(service==='ovh')this.ovhPool.networkFailure(id);}
  async observe(id,response,options={},service='ovh'){
    if(service==='ovh'){
      await this.ovhPool.observe(id,response,options);
      const until=retryAt(response.headers.get('retry-after'),this.now());
      if(response.status===429||until){
        const knownModel=(this.ovhPool.confirmed.get(id)||0)>this.now();
        const at=Math.max(until||0,this.ovhPool.ready.get(id)||0,this.ovhPool.confirmed.get(id)||0);
        if(knownModel)this.ovhCooldowns={...this.ovhCooldowns,models:{...this.ovhCooldowns.models,[id]:Math.max(Object.hasOwn(this.ovhCooldowns.models,id)?this.ovhCooldowns.models[id]:0,at)}};
        else this.ovhCooldowns={...this.ovhCooldowns,providerUntil:Math.max(this.ovhCooldowns.providerUntil,at)};
        this.noteCooldown(id,response,service,until??Math.max(knownModel?this.ovhCooldowns.models[id]:this.ovhCooldowns.providerUntil,0),knownModel?'model':'service',until?'retry-after':'ovh-ledger',until);
        await this.enqueue(()=>this.persistRotation({...this.rotation}));
      }
      return;
    }
    // A rejection is associated with its exact requested model. Broader gates
    // require an explicit server scope declaration, never Retry-After alone.
    const until=retryAt(response.headers.get('retry-after'),this.now());
    if(response.status===429||until){
      const broad=/^(provider|service|global|account|ip)$/i.test(response.headers.get('x-ratelimit-scope')??'');
      const gates=broad?this.barriers:this.modelBarriers,key=broad?service:recordKey(service,id);
      const at=until??this.now()+61000,old=gates.get(key)?.until??0;
      gates.set(key,{until:Math.max(old,at)});
      // Record this response's own deadline, not a longer older barrier it did not cause.
      this.noteCooldown(id,response,service,at,broad?'service':'model',until?'retry-after':'fallback',until);
      await this.enqueue(()=>this.persistRotation({...this.rotation}));
    }
  }
  selectionCheck(text){this.lastCheck=clean(text).slice(0,8192);this.lastCheckAt=this.now();}
  failureError(code,text){return Object.assign(Error(text),{poolFailure:code});}
  pauseError(){
    const exhausted=this.config.cycles&&this.rotation.completed>=this.config.cycles;
    return this.failureError(exhausted?'finite-allowance-exhausted':'review-required',exhausted
      ? 'Free pool paused [finite-allowance-exhausted]: cycle allowance completed. Skipped visits count as passes, not successful responses. Review settings to explicitly restart the rotation or leave the pool; cooldowns are not reset.'
      : 'Free pool paused [review-required]: review settings and explicitly restart after repairing the saved runtime. Provider quota is not reset.');
  }
  waitFailure(){return `Free pool local wait budget expired before HTTP [readiness-wait-expired]; no request was sent. Readiness wait: ${this.config.maxWaitMs/1000}s. The response-start timer did not start. Cooldowns were not cleared. `+(this.lastCheck?`Last selection check (historical): ${this.lastCheck}`:'');}
  noteCooldown(id,response,service,until,scope,source,validRetry){
    const raw=response.headers.get('retry-after');
    try {
      const [entry]=readCooldownEvidence([{service,model:id,status:response.status,at:this.now(),until,scope,source,
        retryAfterState:validRetry?'valid':raw===null?'missing':'invalid',retryAfter:validRetry&&raw.trim().length<=128?raw.trim():null}]);
      this.cooldownEvidence=[...this.cooldownEvidence,entry].slice(-MAX_COOLDOWN_EVIDENCE);
    }catch{this.diagnosticWarning='Some cooldown evidence could not be retained; enforcement is unchanged.';}
  }
  cooldownStatus(key,at=this.now()){
    const {service,id}=parsePoolKey(key),until=this.until(key);
    if(until<=at)return 'no active local cooldown; request compatibility is checked only at dispatch';
    const evidence=[...this.cooldownEvidence].reverse().find(e=>e.service===service&&(e.scope==='service'||e.model===id)&&e.until===until);
    const reason=evidence?cooldownEvidenceText(evidence):service==='ovh'&&until===this.durableOvhUntil(id)
      ? 'OVH durable reservation ledger (not a new provider rejection)'
      : service==='ovh'&&until===this.ovhPool.quota.until(id)
      ? 'OVH conservative quota ledger (not a new provider rejection)'
      : 'origin unavailable (older saved state, omitted evidence or another quota gate); no new provider response is implied';
    return `cooling ${Math.ceil((until-at)/1000)}s; until ${iso(until)}; ${reason}`;
  }
  preview(visits=20){
    const c=this.config,r=this.rotation,rr=schedulingMode(c)==='round-robin';
    const lines=['Planned visits only; no requests will be sent.',
      `Mode: ${schedulingMode(c)}; cycles: ${c.cycles||'continuous'}; completed: ${r.completed}; ${r.paused?'PAUSED':'active'}`,
      `Pool: ${c.enabled?'ON':'OFF (stored schedule only)'}. Completed passes are NOT counts of successful answers.`,
      'Skipped unavailable/incompatible/cooling visits count toward cycles, with zero requests. Provider limits override weights.'];
    if(!c.models.length)return [...lines,'No models selected.'].join('\n');
    if(!rr)return [...lines,'Priority chooses the first ready compatible entry at each safe boundary; weights do not force rotation.'].join('\n');
    if(r.paused)return [...lines,'No upcoming visits while PAUSED. Explicit reviewed restart is required; it never clears cooldowns.'].join('\n');
    lines.push(`Current visit: ${r.cursor+1}/${c.models.length}; ${clean(c.models[r.cursor])}; reserved ${r.used}/${c.weights[c.models[r.cursor]]}; remaining ${c.weights[c.models[r.cursor]]-r.used}.`,
      'Conditional schedule from the saved position (not a prediction of live readiness):');
    let cursor=r.cursor,completed=r.completed,used=r.used,n=0;
    const limit=Number.isSafeInteger(visits)?Math.min(100,Math.max(0,visits)):20;
    for(;n<limit&&(!c.cycles||completed<c.cycles);n++){
      const key=c.models[cursor];lines.push(`${n+1}. ${clean(key)} × ${c.weights[key]-used} remaining in pass ${completed+1}`);
      used=0;cursor++;if(cursor===c.models.length){cursor=0;completed++;}
    }
    lines.push(c.cycles&&completed>=c.cycles?'Then PAUSE at the finite allowance.':'Further visits omitted; continuous means scheduling existing requests, never generating prompts.');
    return lines.join('\n');
  }
  report(){
    const at=this.now();
    return [`Current scheduling snapshot — ${iso(at)} (local gates, not a live provider probe)`,this.preview(),
      `Readiness wait: ${this.config.maxWaitMs/1000}s; response-start: ${this.config.responseStartTimeoutMs/1000}s (0 = disabled).`,
      'Current local cooldowns (not a request-compatibility test):',
      ...this.config.models.map(k=>`${clean(k)} — thinking ${clean(this.mode(k))}; ${this.cooldownStatus(k,at)}`),
      'Kilo policy: model-local cooldown by default. A service-wide gate requires an explicit server X-Ratelimit-Scope declaration. A 429 without valid Retry-After uses a 61-second model-local package backoff, not a verified provider limit. Pre-activity 429 may advance once per untried identity; no failover after meaningful activity.',
      ...this.unsupported(),
      ...(this.lastCheck?[`Last selection check — ${iso(this.lastCheckAt)} (HISTORICAL; not current readiness):`,this.lastCheck]:[]),
      `Cooldown response evidence (HISTORICAL; newest ${MAX_COOLDOWN_EVIDENCE} retained; expired records do not mean an active block):`,
      ...(this.cooldownEvidence.length?[...this.cooldownEvidence].reverse().map(cooldownEvidenceText):['No response provenance retained. Older state cannot reconstruct the triggering HTTP response.']),
      this.policyNotice||'',this.warning||'',this.diagnosticWarning||''].filter(Boolean).join('\n');
  }
}
