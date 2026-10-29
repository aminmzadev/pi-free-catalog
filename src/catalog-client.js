// Pages-first adapter with strict, versioned two-provider snapshot validation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Catalog, SOURCES, reconcile, validateState, atomicJSON, isGzip } from './catalog.js';
import { lifecycle, explicitDeadlines } from './lifecycle.js';
import { migrateCatalogState } from './provider-removal.js';
import { PREVIOUS_URL, MAX_SOURCE_BYTES, MAX_SNAPSHOT_BYTES, canonical, dataHash, rulesHash, validateSnapshot, asState } from './snapshot-contract.js';

export const PAGES_URL = PREVIOUS_URL;
export const SOFT_SOURCE_AGE_MS = 45 * 60 * 1000;
const CACHE_LIMIT = 64 * 1024 * 1024;
function aborted(signal) { if (signal?.aborted) throw signal.reason || new DOMException('Cancelled','AbortError'); }
function cancelBody(body){try{void Promise.resolve(body?.cancel()).catch(()=>{});}catch{}}
async function bounded(promise, signal) {
  const task=Promise.resolve(promise);
  if(signal?.aborted){void task.catch(()=>{});aborted(signal);}
  let rejectAbort;
  const abort = new Promise((resolve,reject) => { rejectAbort = () => reject(signal.reason || new DOMException('Cancelled','AbortError')); signal.addEventListener('abort',rejectAbort,{once:true}); });
  try { return await Promise.race([task,abort]); }
  finally { signal.removeEventListener('abort',rejectAbort); }
}
export async function metadataResponse(fetcher, url, { signal, timeout = 6000, pages = false } = {}) {
  assert.ok(pages ? url === PAGES_URL : Object.values(SOURCES).includes(url),'Metadata URL outside allowlist');
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
  const target = pages ? url + '?catalog_read=' + randomUUID() : url;
  aborted(combined);
  const pending = Promise.resolve().then(() => fetcher(target, {
    method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:combined,
    headers:{accept:'application/json','cache-control':'no-cache','user-agent':'pi-free-catalog/0.1.8'},
  }));
  // A non-cooperative fetch may settle after cancellation; discard its late body too.
  void pending.then(response=>{if(combined.aborted)cancelBody(response.body);},()=>{});
  const response=await bounded(pending,combined);
  if(response.status !== 200) { cancelBody(response.body); throw new Error('Metadata HTTP '+response.status); }
  const reader=response.body?.getReader();assert.ok(reader,'Missing metadata body');
  const chunks=[];let size=0;const limit=pages?MAX_SNAPSHOT_BYTES:MAX_SOURCE_BYTES;
  try{
    while(true){const {done,value}=await bounded(reader.read(),combined);if(done)break;size+=value.byteLength;assert.ok(size<=limit,'Metadata exceeds size limit');chunks.push(Buffer.from(value));}
  }catch(error){cancelBody(reader);throw error;}
  finally{try{reader.releaseLock?.();}catch{}}
  aborted(combined);
  // Return a bounded buffered response; the existing direct-source parser remains unchanged.
  return new Response(Buffer.concat(chunks),{status:200,headers:{'content-type':'application/json'}});
}
function hasEntries(state){return Object.keys(state.entries || {}).length>0;}
function checkLocal(state, now){
  validateState(state);
  if(state.refreshedAt)assert.ok(Number.isFinite(Date.parse(state.refreshedAt))&&Date.parse(state.refreshedAt)<=now+300000,'Invalid cache timestamp');
  for(const [name,s]of Object.entries(state.sources)){
    if(s.url!==undefined)assert.equal(s.url,SOURCES[name],'Unexpected cached source URL');
    if(s.fetchedAt)assert.ok(Number.isFinite(Date.parse(s.fetchedAt))&&Date.parse(s.fetchedAt)<=now+300000,'Invalid cached source time');
  }
  assert.ok(Buffer.byteLength(canonical(state))<=CACHE_LIMIT,'Cache exceeds size limit');return state;
}
function applyDeadlines(state, now){
  for(const e of Object.values(state.entries))if(e.lifecycle==='retired'||[e.raw,e.metadata].some(r=>lifecycle(r,now)==='retired')||[...(e.retirementDates||[]),...explicitDeadlines([e.raw,e.metadata])].some(d=>Date.parse(d)<=now))e.lifecycle='retired';
  return state;
}
export function snapshotState(snapshot, local, now){
  for(const [name,s]of Object.entries(snapshot.sources)){
    const prior=Date.parse(local.sources?.[name]?.fetchedAt);
    assert.ok(!Number.isFinite(prior)||Date.parse(s.fetchedAt)>=prior,'Pages data is older than local source evidence');
  }
  const remote=asState(snapshot),entries={...structuredClone(local.entries||{}),...structuredClone(remote.entries)};
  for(const [key,e]of Object.entries(entries)){
    const earlier=local.entries?.[key]?.firstSeen;
    if(earlier&&Number.isFinite(Date.parse(earlier))&&Date.parse(earlier)<Date.parse(e.firstSeen))e.firstSeen=earlier;
  }
  const seen=new Map();
  for(const event of [...(local.history||[]),...remote.history])seen.set(dataHash(event),event);
  const history=[...seen.values()].sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)).slice(-2000);
  // Use the observation time, never the download time, for listings/provenance.
  const state=reconcile(snapshot.sources,{...remote,entries,history},snapshot.generatedAt);
  state.sources=Object.fromEntries(Object.entries(snapshot.sources).map(([name,s])=>[name,{
    url:s.url,fresh:s.fresh,fetchedAt:s.fetchedAt,attemptedAt:s.attemptedAt,data:structuredClone(s.data),
    ...(!s.fresh?{error:'Retained snapshot source: '+s.failure.code}:{}),
  }]));
  state.delivery={transport:'pages',receivedAt:new Date(now).toISOString(),snapshotGeneratedAt:snapshot.generatedAt,commit:snapshot.producer.commit,runId:snapshot.producer.runId,payloadHash:snapshot.integrity.payloadHash};
  return checkLocal(applyDeadlines(state,now),now);
}
export class PagesCatalog extends Catalog {
  constructor(options={}){
    super(options);this.pagesTimeout=options.pagesTimeout??6000;this.softSourceAge=options.softSourceAge??SOFT_SOURCE_AGE_MS;
    this.persist=options.persist??atomicJSON;this.rules=undefined;this.lastRefresh=null;
  }
  async load(){
    if(!this.file)return;
    try{
      assert.ok((await stat(this.file)).size<=CACHE_LIMIT,'Cache file exceeds size limit');
      const bytes=await readFile(this.file);const text=isGzip(bytes)?gunzipSync(bytes,{maxOutputLength:CACHE_LIMIT}).toString('utf8'):bytes.toString('utf8');
      this.state=checkLocal(applyDeadlines(migrateCatalogState(JSON.parse(text)),this.now()),this.now());
    }catch(error){if(error.code!=='ENOENT')this.cacheWarning='Saved catalog could not be validated; a network refresh will be attempted.';}
  }
  async commit(state,signal){
    aborted(signal);checkLocal(state,this.now());
    if(this.file)try{await this.persist(this.file,state,{gzip:true});this.cacheWarning=undefined;}catch{this.cacheWarning='The validated catalog is active, but could not be saved. The previous disk cache was preserved.';}
    this.state=state;return state;
  }
  async _refresh(signal){
    aborted(signal);const old=this.state;const previousAttempt=this.lastAttempt;this.lastAttempt=this.now();this.refreshWarning=undefined;
    let pagesState=null,pagesFailure='unavailable';
    try{
      const response=await metadataResponse(this.fetcher,PAGES_URL,{signal,timeout:this.pagesTimeout,pages:true});
      const bytes=Buffer.from(await response.arrayBuffer());
      const snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      this.rules??=rulesHash();validateSnapshot(snapshot,{expectedRules:await this.rules,now:this.now()});
      pagesState=snapshotState(snapshot,old,this.now());
      const aged=Object.values(snapshot.sources).some(s=>this.now()-Date.parse(s.fetchedAt)>this.softSourceAge);
      if(!aged){this.lastRefresh={transport:'pages',at:this.now(),quality:snapshot.quality.status};return await this.commit(pagesState,signal);}
      pagesFailure='stale';
    }catch(error){if(signal?.aborted){this.lastAttempt=previousAttempt;throw error;}pagesFailure=pagesState?'stale':'unavailable-or-invalid';}
    aborted(signal);
    const direct=new Catalog({now:this.now,timeout:this.timeout,fetch:(url,init)=>metadataResponse(this.fetcher,url,{signal:init?.signal,timeout:this.timeout})});
    direct.state=structuredClone(pagesState||old);
    try{
      const state=await direct.refresh({signal});aborted(signal);
      if(Object.values(state.sources).some(s=>s.fresh)){
        state.delivery={transport:'direct',receivedAt:new Date(this.now()).toISOString(),pages:pagesFailure};
        this.lastRefresh={transport:'direct',at:this.now(),pages:pagesFailure};return await this.commit(checkLocal(applyDeadlines(state,this.now()),this.now()),signal);
      }
    }catch(error){if(signal?.aborted){this.lastAttempt=previousAttempt;throw error;}}
    this.refreshWarning=hasEntries(old)||pagesState?'Catalog refresh incomplete; using the saved catalog where available. Chat remains available for cached confirmed-free models.':'Catalog refresh failed and no saved free models are available. Restore connectivity and use /free-refresh.';
    this.lastRefresh={transport:hasEntries(old)?'cache':pagesState?'stale-pages':'empty',at:this.now(),pages:pagesFailure};
    if(!hasEntries(old)&&pagesState)return await this.commit(pagesState,signal);
    return old; // Never overwrite an existing usable cache with a failed/empty refresh.
  }
}
