// Fail-closed response classification. No message-text matching or invented OVH error-code assumptions.
const HTTP_DATE=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
export function retryAt(value,now){
 if(typeof value!=='string')return null;
 const text=value.trim();let at;
 if(/^\d+(?:\.\d+)?$/.test(text))at=now+Number(text)*1000;
 else if(HTTP_DATE.test(text)){at=Date.parse(text);if(!Number.isFinite(at)||new Date(at).toUTCString()!==text)return null;}
 return Number.isFinite(at)&&at>now&&at<=Number.MAX_SAFE_INTEGER?at:null;
}
// Scope comes from the unchanged anonymous OVH transport's exact request/model
// association plus catalog entitlement, never from prose or Retry-After alone.
const OVH_CHAT='https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
function contradictoryScope(id,headers,body){
 const e=body?.error;
 for(const key of ['provider_wide','global','account_wide','ip_wide'])if([e?.[key],body?.[key]].some(v=>v!==undefined&&v!==false))return true;
 for(const value of [body?.scope,body?.rate_limit_scope,e?.scope])if(value!==undefined&&value!=='model')return true;
 if(headers.has('x-ratelimit-scope')&&headers.get('x-ratelimit-scope')!=='model')return true;
 if(headers.has('x-ratelimit-model')&&headers.get('x-ratelimit-model')!==id)return true;
 if(headers.has('x-ratelimit-window')&&headers.get('x-ratelimit-window')!=='60')return true;
 return false;
}
function observedOvhMinute(id,headers,body,now,retry,{url,model,anonymousRateLimit}={}){
 if(url!==OVH_CHAT||model!==id||anonymousRateLimit!==2||!body||typeof body!=='object'||Array.isArray(body))return false;
 // Captured live 2026-10-23. All independent quota fields and the response's
 // correlation ID must agree. Other/unknown bodies and quota windows fail closed.
 if(Object.keys(body).sort().join(',')!=='message,request_id'||body.message!=='API rate limit exceeded'||
    !/^[a-f0-9]{32}$/.test(body.request_id)||headers.get('inference-id')!==body.request_id)return false;
 for(const [name,value]of [['ratelimit-limit','2'],['x-ratelimit-limit-minute','2'],['ratelimit-remaining','0'],['x-ratelimit-remaining-minute','0']])if(headers.get(name)!==value)return false;
 const reset=headers.get('ratelimit-reset');if(!/^(?:[1-9]|[1-5][0-9]|60)$/.test(reset||''))return false;
 const seconds=Number(reset);if(retry-now>60000||Math.abs((retry-now)/1000-seconds)>1)return false;
 for(const [name]of headers){
  if(/^x-ratelimit-(?:limit|remaining)-/.test(name)&&!/^x-ratelimit-(?:limit|remaining)-minute$/.test(name))return false;
 }
 if(headers.has('ratelimit-policy')||headers.has('x-ratelimit-reset-day')||headers.has('x-ratelimit-reset-hour'))return false;
 return true;
}
export function cooldownEvidence(id,status,headers,body,now,request={}){
 if(typeof id!=='string'||!id||id.trim()!==id||status!==429||contradictoryScope(id,headers,body))return null;
 const retry=retryAt(headers.get('retry-after'),now),e=body?.error;
 if(!retry)return null;
 const structured=e&&typeof e==='object'&&!Array.isArray(e)&&e.type==='rate_limit_error'&&e.scope==='model'&&e.model===id&&e.period==='minute'&&e.limit===2&&(e.code===undefined||e.code==='rate_limit_exceeded');
 if(!structured&&!observedOvhMinute(id,headers,body,now,retry,request))return null;
 return {model:id,until:retry,scope:'model',period:'minute'};
}
export function providerWide(status,headers,body){
 if(status!==429)return false;
 const scopes=[headers.get('x-ratelimit-scope'),body?.scope,body?.rate_limit_scope,body?.error?.scope];
 return scopes.some(s=>['provider','global','account','ip','organization'].includes(s))||['provider_wide','global','account_wide','ip_wide'].some(k=>body?.error?.[k]===true||body?.[k]===true);
}
export async function boundedErrorBody(response,{signal,timeout=200,maxBytes=16384}={}){
 if(!/application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get('content-type')||''))return null;
 const deadline=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([signal,deadline]):deadline;
 let reader,clone;
 try{
  clone=response.clone();reader=clone.body?.getReader();if(!reader)return null;
  const chunks=[];let size=0;
  while(true){
   const result=await abortable(reader.read(),combined);if(result.done)break;
   size+=result.value.byteLength;if(size>maxBytes)return null;chunks.push(Buffer.from(result.value));
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }catch{return null;}
 finally{try{void Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}try{reader?.releaseLock();}catch{}}
}
export async function abortable(promise,signal){
 const task=Promise.resolve(promise);if(signal?.aborted){void task.catch(()=>{});throw signal.reason??new DOMException('Cancelled','AbortError');}
 if(!signal)return task;
 let listener;
 try{return await Promise.race([task,new Promise((_,reject)=>{listener=()=>reject(signal.reason??new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',listener,{once:true});})]);}
 finally{signal.removeEventListener('abort',listener);}
}
