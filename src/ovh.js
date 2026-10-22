import { validDeadline } from './lifecycle.js';
export const OVH_BASE='https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
export const OVH_POLICY='https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const array=v=>Array.isArray(v)?v:[];

/** Rich catalog names/aliases, NOT name patterns, link metadata to runtime IDs.
 * An ambiguous match supplies no entitlement; inventory is still retained as unknown.
 */
export function ovhRecord(id,document) {
  const matches=array(document).filter(m=>[m.name,m.id,...array(m.metadata?.aliases)].includes(id));
  return matches.length===1?matches[0]:null;
}
export function ovhMetadata(raw,rich) {
  if(!rich)return structuredClone(raw);
  const meta=rich.metadata||{},caps=meta.model_specs?.capabilities||{};
  const rate=array(meta.usage_information?.rate_limit?.rate_limit_api_anonymous).find(r=>r.rate_limit_unit==='req/m'&&typeof r.rate_limit_value==='number'&&r.rate_limit_value>0)?.rate_limit_value;
  const declared=meta.publishing_information?.model_eol_date;
  const date=typeof declared==='string'&&/^\d{2}\/\d{2}\/\d{4}$/.test(declared)?declared.split('/').reverse().join('-'):null;
  const deadline=validDeadline(date)?date:null;
  const type=rich.category_v2==='Text Generation'?'chat':rich.category_v2==='Embeddings'?'embedding':rich.category_v2==='Image Generation'?'image':'other';
  return {
    ...structuredClone(raw),name:typeof rich.name==='string'?rich.name:raw.id,type,
    architecture:{input_modalities:array(caps.input_modality),output_modalities:array(caps.output_modality)},
    reasoning:caps.reasoning===true,tool_call:caps.function_calling===true,
    ...(array(caps.reasoning_efforts).length?{reasoning_options:[{type:'effort',values:array(caps.reasoning_efforts).filter(v=>typeof v==='string')}]}:{}),
    ...(deadline?{retirement_date:deadline,status:'deprecated'}:{}),
    ovh:{anonymousRateLimit:rate??null,policy:OVH_POLICY,catalogAvailable:rich.available,richRecord:structuredClone(rich)},
  };
}
export function validateOvhCatalog(data) {
  if(!Array.isArray(data)||!data.length)throw new Error('Empty or invalid OVH metadata catalog');
  const ids=new Set();
  for(const m of data){
    if(!object(m)||typeof m.id!=='string'||!m.id.trim()||ids.has(m.id)||typeof m.name!=='string'||!m.name.trim()||!object(m.metadata))throw new Error('Invalid/duplicate OVH metadata record');
    const caps=m.metadata.model_specs?.capabilities;
    if(typeof m.category_v2!=='string'||!m.category_v2.trim()||!object(caps)||
      !['input_modality','output_modality'].every(k=>Array.isArray(caps[k])&&caps[k].every(v=>typeof v==='string'))||
      !['function_calling','reasoning','streaming'].every(k=>typeof caps[k]==='boolean')||
      (m.metadata.aliases!==undefined&&(!Array.isArray(m.metadata.aliases)||!m.metadata.aliases.every(v=>typeof v==='string'&&v.trim())))||
      (caps.reasoning_efforts!==undefined&&(!Array.isArray(caps.reasoning_efforts)||!caps.reasoning_efforts.every(v=>typeof v==='string'&&v.trim()))))
      throw new Error('Incomplete OVH capability metadata');
    ids.add(m.id);
  }
  return data;
}

function aborted(signal){if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');}
export function cancellableDelay(ms,signal) {
  aborted(signal);
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);reject(signal.reason??new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},Math.min(ms,2147483647));
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}
/** Per-running-extension, per-model pacing; the upstream IP-wide quota remains authoritative.
 * Queued cancellation releases its gate without allowing successors past earlier requests.
 */
export function createOvhPacer({now=()=>Date.now(),sleep=cancellableDelay,interval=31000}={}) {
  const tails=new Map(),next=new Map();
  return {
    async wait(id,{signal,onWait}={}){
      aborted(signal);
      const prior=tails.get(id)||Promise.resolve();let release;
      const gate=new Promise(r=>{release=r;});const tail=prior.then(()=>gate);tails.set(id,tail);
      let abort;
      try{
        await Promise.race([prior,new Promise((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);
        aborted(signal);
        // A different in-flight request can extend Retry-After while we are waiting.
        while((next.get(id)||0)>now()){
          const ms=next.get(id)-now();onWait?.(ms);await sleep(ms,signal);aborted(signal);
        }
        next.set(id,now()+interval);
      }finally{
        signal?.removeEventListener('abort',abort);release();
        if(tails.get(id)===tail)void tail.then(()=>{if(tails.get(id)===tail)tails.delete(id);});
      }
    },
    observe(id,response){
      if(response.status!==429)return;
      const retry=response.headers.get('retry-after');
      const seconds=retry!==null&&/^\d+(?:\.\d+)?$/.test(retry.trim())?Number(retry):null;
      const httpDate=typeof retry==='string'&&/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry.trim());
      const at=seconds!==null?now()+seconds*1000:httpDate?Date.parse(retry):NaN;
      next.set(id,Math.max(next.get(id)||0,Number.isFinite(at)?at:now()+interval));
    },
  };
}
