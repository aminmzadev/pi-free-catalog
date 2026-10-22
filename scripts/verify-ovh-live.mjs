/** Opt-in LIVE proof of the unchanged production extension through Pi's real loader.
 * Set a clean HOME and PI_CODING_AGENT_DIR. No personal credentials are read.
 * node scripts/verify-ovh-live.mjs /absolute/evidence-directory [--installed]
 * --installed loads the package from clean `pi install` settings, not a factory.
 * One gpt-oss-120b four-tool workflow: six-request hard cap, 210-second deadline.
 * Test-only fetch audit forwards allowed requests unchanged; it is NEVER production code.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { SOURCES, PROVIDERS, summary, validateState } from '../src/catalog.js';
import { gunzipSync } from 'node:zlib';
import { assessToolWorkflow } from './live-checks.mjs';
const root=resolve(process.argv[2]||'ovh-live-proof'),cwd=join(root,'work'),agentDir=process.env.PI_CODING_AGENT_DIR;
if(!agentDir||!process.env.HOME)throw new Error('Set clean HOME and PI_CODING_AGENT_DIR first');
const installed=process.argv.includes('--installed'),id='gpt-oss-120b',url=SOURCES.ovh.replace(/\/models$/,'/chat/completions');
await mkdir(cwd,{recursive:true});await mkdir(agentDir,{recursive:true});
const nativeFetch=globalThis.fetch,wires=[],gets=[],pending=[],events=[],errors=[],statuses=[],notes=[];
let session,deadline,attempts=0,thrown,exceeded=false;
const saveWires=()=>writeFile(join(root,'wires.json'),JSON.stringify(wires,null,2));
// Audit guard only: never inserts credentials, changes headers, retries, paces, or fabricates a response.
globalThis.fetch=async(input,init={})=>{
 const target=String(input instanceof Request?input.url:input),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
 if(method==='GET'){
  if(!Object.values(SOURCES).includes(target))throw new Error('Audit boundary: unrelated catalog URL');
  const response=await nativeFetch(input,init),row={url:target,http:response.status,at:new Date().toISOString()};gets.push(row);
  const name=Object.keys(SOURCES).find(k=>SOURCES[k]===target);
  pending.push(response.clone().text().then(text=>writeFile(join(root,`catalog-${name}.json`),text)));
  return response;
 }
 const body=JSON.parse(typeof init.body==='string'?init.body:await input.clone().text());
 const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
 if(method!=='POST'||target!==url||body.model!==id||++attempts>6||headers.has('authorization')||headers.has('x-api-key')||headers.has('cookie')){
  exceeded=attempts>6;throw new Error('Audit boundary: endpoint/model/auth/six-request budget');
 }
 const row={number:attempts,url:target,method,at:new Date().toISOString(),headers:Object.fromEntries(headers),body};wires.push(row);await saveWires();
 try{
  const response=await nativeFetch(input,init);row.http=response.status;row.responseHeaders=Object.fromEntries(response.headers);
  pending.push(response.clone().text().then(text=>writeFile(join(root,`response-${row.number}.txt`),text)));
  await saveWires();return response;
 }catch(error){row.error=String(error);await saveWires();throw error;}
};
const token=randomBytes(12).toString('hex'),fixture=`nonce=${token}\n`,expected=`nonce=${token}\nstatus=verified\n`,sha=createHash('sha256').update(expected).digest('hex');
const verifier="from pathlib import Path\nimport hashlib\nn=Path('fixture.txt').read_text().strip().split('=',1)[1]\nb=Path('result.txt').read_bytes()\nassert b==f'nonce={n}\\nstatus=verified\\n'.encode(),repr(b)\nprint('VERIFIED',n,hashlib.sha256(b).hexdigest())\n";
await writeFile(join(cwd,'fixture.txt'),fixture);await writeFile(join(cwd,'verify.py'),verifier);
const audit=pi=>{
 // Public payload hook caps output for this bounded TEST, not a provider capability claim.
 pi.on('before_provider_request',({payload})=>({...payload,max_tokens:4096}));
 pi.on('tool_call',e=>{
  const a=e.input||{},path=typeof a.path==='string'?resolve(cwd,a.path):null;
  const safe=e.toolName==='bash'?a.command==='python3 verify.py':e.toolName==='read'?path===join(cwd,'fixture.txt'):['write','edit'].includes(e.toolName)&&path===join(cwd,'result.txt');
  if(!safe)return {block:true,reason:'Audit: only the specified fixture/result paths and exact verifier command are allowed.'};
 });
};
const started=new Date().toISOString();let result;
try{
 let settings={};try{settings=JSON.parse(await readFile(join(agentDir,'settings.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const settingsManager=SettingsManager.inMemory({...settings,retry:{enabled:false,maxRetries:0},compaction:{enabled:false}});
 const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:!installed,additionalExtensionPaths:installed?[]:[fileURLToPath(new URL('../index.js',import.meta.url))],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[audit]});
 await loader.reload();const loaded=loader.getExtensions();
 if(loaded.errors.length)throw new Error('Loader errors: '+JSON.stringify(loaded.errors));
 ({session}=await createAgentSession({cwd,agentDir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(cwd)}));
 await session.bindExtensions({mode:'tui',uiContext:{setStatus:(key,value)=>statuses.push({key,value,at:new Date().toISOString()}),setFooter(){},notify:(...a)=>notes.push(a)},onError:e=>errors.push(e)});
 const models=session.modelRuntime.getAllModels();
 const namespaces=Object.fromEntries(Object.values(PROVIDERS).map(p=>[p,models.filter(m=>m.provider===p).map(m=>({id:m.id,type:m.type,contextWindow:m.contextWindow,maxTokens:m.maxTokens,thinkingLevelMap:m.thinkingLevelMap}))]));
 if(Object.values(namespaces).some(list=>!list.length))throw new Error('Three-provider coexistence not established');
 const activeTools=session.getActiveToolNames();if(!['read','write','edit','bash'].every(n=>activeTools.includes(n)))throw new Error('Default tools missing');
 const model=session.modelRuntime.getModel('free-ovh',id);if(!model)throw new Error('Requested OVH model not eligible in live catalogs');
 await session.setModel(model);session.setThinkingLevel('low');
 session.subscribe(e=>{if(['tool_execution_start','tool_execution_end','agent_end'].includes(e.type))events.push(e);});
 deadline=setTimeout(()=>{thrown='210-second live deadline';void session.abort();},210000);
 const beforeGets=gets.length;
 await session.prompt('Complete this exact local-file verification workflow using the available tools. Use ONE tool call per assistant turn and wait for its result. Step 1: read fixture.txt using read; it contains a secret nonce you must obtain from that file. Step 2: use write to create result.txt with exactly two lines: nonce=THE_NONCE_YOU_READ and status=draft, with a newline after each line. Step 3: use edit to replace status=draft with status=verified in result.txt, changing nothing else. Step 4: use bash with exactly this command: python3 verify.py. Do not read or modify verify.py. Step 5: after the verifier succeeds, answer exactly DONE followed by the nonce and the SHA256 printed by the verifier. Do not simulate tool results, use bash to replace other tools, or access any other files.');
 clearTimeout(deadline);
 const last=session.messages.filter(m=>m.role==='assistant').at(-1),answer=(last?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 let data;try{data=await readFile(join(cwd,'result.txt'),'utf8');}catch{}
 const assessed=assessToolWorkflow({events,cwd,dir:cwd,data,expected,answer,last,sha,token,fixtureUnchanged:await readFile(join(cwd,'fixture.txt'),'utf8')===fixture,verifierUnchanged:await readFile(join(cwd,'verify.py'),'utf8')===verifier});
 const cacheBytes=await readFile(join(agentDir,'free-catalog/catalog.json')),catalog=validateState(JSON.parse(gunzipSync(cacheBytes).toString('utf8')));
 await Promise.all(pending);
 const responseModels=[];
 for(const w of wires){
  const text=await readFile(join(root,`response-${w.number}.txt`),'utf8');
  const models=[...new Set(text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6)).model).filter(Boolean))];
  responseModels.push({number:w.number,models,done:text.includes('data: [DONE]')});
 }
 const sameResponseModel=wires.every(w=>w.http===200)&&responseModels.every(r=>r.models.length>0&&r.models.every(m=>m===id)&&r.done);
 result={started,finished:new Date().toISOString(),node:process.version,installedLoader:installed,productionSourcePatched:false,testOutputCap:4096,model:id,thinking:session.thinkingLevel,activeTools,namespaces,catalogCounts:summary(catalog),sourceHealth:Object.fromEntries(Object.entries(catalog.sources).map(([k,v])=>[k,{fresh:v.fresh,fetchedAt:v.fetchedAt,error:v.error}])),assessed,responseModels,answer,expectedSha256:sha,actualFile:data,inferenceRequests:wires.length,catalogFetches:gets.length,catalogFetchesDuringInference:gets.length-beforeGets,budgetExceeded:exceeded,errors,thrown,pass:assessed.pass&&sameResponseModel&&gets.length===beforeGets&&!exceeded&&!thrown&&errors.length===0&&wires.length<=6&&wires.every(w=>w.body.model===id&&w.body.reasoning_effort==='low')};
 await writeFile(join(root,'messages.json'),JSON.stringify(session.messages,null,2));
}catch(error){thrown=String(error);result={started,finished:new Date().toISOString(),pass:false,thrown,inferenceRequests:wires.length,budgetExceeded:exceeded,errors};}
finally{
 clearTimeout(deadline);if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
 globalThis.fetch=nativeFetch;await Promise.allSettled(pending);
 await writeFile(join(root,'events.json'),JSON.stringify(events,null,2));await writeFile(join(root,'status.json'),JSON.stringify({statuses,notes},null,2));await writeFile(join(root,'catalog-fetches.json'),JSON.stringify(gets,null,2));
 await saveWires();await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));
}
console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1;
