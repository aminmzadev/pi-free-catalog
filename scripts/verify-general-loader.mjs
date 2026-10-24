// Actual bundled CLI / native SDK with fixture POSTs; socket access is forbidden.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,cp,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
const preload=`
import assert from 'node:assert/strict';
import {readFileSync,appendFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Socket} from 'node:net';
Socket.prototype.connect=function(){throw Error('Network sockets forbidden in general pool CLI test');};
const metadata={
'https://api.kilo.ai/api/gateway/models':'kilo',
'https://opencode.ai/zen/v1/models':'opencode',
'https://models.opencode.ai/api.json':'opencode-capabilities',
'https://models.dev/api.json':'models-dev',
'https://pi.dev/api/models/providers/opencode?types=chat,image,classifier':'pi-opencode-catalog',
'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models':'ovh-models',
'https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2':'ovh-catalog'};
const endpoints={
'https://api.kilo.ai/api/gateway/chat/completions':['kilo','reflection/beam-free'],
'https://opencode.ai/inference/v1/chat/completions':['zen','beam-free'],
'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions':['ovh','gpt-oss-120b']};
const fetcher=async(input,init={})=>{
 const url=String(input instanceof Request?input.url:input),method=(init.method??'GET').toUpperCase();
 if(method==='GET'){
  appendFileSync(process.env.GENERAL_CLI_LOG,JSON.stringify({method,url,network:false})+'\\n');
  const p=new URL(url);if(p.origin+p.pathname==='https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json')return new Response(null,{status:503});
  assert.ok(metadata[url],url);return new Response(gunzipSync(readFileSync(process.env.GENERAL_CLI_FIXTURES+'/'+metadata[url]+'.json.gz')),{headers:{'content-type':'application/json'}});
 }
 assert.equal(method,'POST');assert.ok(endpoints[url],url);const [service,id]=endpoints[url],body=JSON.parse(init.body),headers=new Headers(init.headers);
 if(process.env.GENERAL_CLI_CONTINUITY==='1')assert.ok(['xingchen-agi/xing4.0-29b-a4b:free','reflection/beam-free'].includes(body.model));else assert.equal(body.model,id);assert.equal(headers.has('cookie'),false);
 if(service==='kilo'){assert.equal(headers.has('authorization'),false);assert.equal(headers.get('x-kilo-free'),'true');}
 else if(service==='zen'){assert.equal(headers.get('authorization'),'Bearer public');assert.equal(headers.get('x-opencode-client'),'cli');}
 else assert.equal(headers.has('authorization'),false);
 appendFileSync(process.env.GENERAL_CLI_LOG,JSON.stringify({method,service,model:body.model,network:false})+'\\n');
 if(process.env.GENERAL_CLI_CONTINUITY==='1'&&body.model==='xingchen-agi/xing4.0-29b-a4b:free')return Response.json({message:'Provider returned error',metadata:{provider_name:'Phala',limit_source:'upstream_provider_shared_pool'}},{status:429});
 return new Response('data: '+JSON.stringify({id:'offline',model:id,choices:[{index:0,delta:{content:'OFFLINE_GENERAL_POOL_FIXTURE'},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>fetcher,set:()=>{}});
`;
export async function verifyGeneralLoader(projectRoot,{continuity=false}={}){
 const root=resolve(projectRoot),entry=fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),cli=join(dirname(entry),'bundle/cli.js'),host=resolve(dirname(entry),'../../..');
 const temp=await mkdtemp(join(tmpdir(),'general-loader-')),rows=[];
 try{
  await writeFile(join(temp,'preload.mjs'),preload);
  for(const localPeers of [false,true])for(const mixed of (continuity?[false]:[false,true])){
   const dir=join(temp,`${localPeers?'local-peers':'host-only'}-${mixed?'mixed':'kilo-zen'}`),plugin=join(dir,'extension'),agent=join(dir,'agent');await mkdir(join(agent,'free-catalog'),{recursive:true});await mkdir(plugin,{recursive:true});
   for(const name of ['index.js','package.json','src'])await cp(join(root,name),join(plugin,name),{recursive:true});
   if(localPeers)await symlink(host,join(plugin,'node_modules'),'dir');
   const pairs=continuity?[['kilo','xingchen-agi/xing4.0-29b-a4b:free'],['kilo','reflection/beam-free']]:[['kilo','reflection/beam-free'],['zen','beam-free'],...(mixed?[['ovh','gpt-oss-120b']]:[])],models=pairs.map(p=>JSON.stringify(p));
   const config={schemaVersion:2,enabled:true,models,weights:Object.fromEntries(models.map(k=>[k,1])),thinking:Object.fromEntries(models.map(k=>[k,'default'])),scheduling:'round-robin',cycles:1,maxWaitMs:0,responseStartTimeoutMs:0};
   const configFile=join(agent,'free-catalog/free-pool.json');await writeFile(configFile,JSON.stringify({schemaVersion:2,...(continuity?{}:{policyVersion:3,modelBarriers:{}}),config,rotation:{cursor:0,used:0,completed:continuity?1:0,paused:continuity},barriers:{},ovhReservations:{},ovhCooldowns:{models:{},providerUntil:0},approvedProviders:[...new Set(pairs.map(p=>p[0]))].sort()}));
   const env={GENERAL_CLI_CONTINUITY:continuity?'1':'0',PATH:process.env.PATH,HOME:join(dir,'home'),PI_CODING_AGENT_DIR:agent,PI_SKIP_VERSION_CHECK:'1',NO_COLOR:'1',LANG:'C.UTF-8',GENERAL_CLI_LOG:join(dir,'fetch.jsonl'),GENERAL_CLI_FIXTURES:join(root,'test/fixtures')};
   const launches=[];
   for(let n=0;n<(continuity?2:models.length+1);n++){
    const args=['--import',join(temp,'preload.mjs'),cli,'--offline','-ne','-ns','-np','--no-themes','-nc','--no-mcp','--no-session','-e',join(plugin,'index.js'),'--provider','free-kilo','--model','reflection/beam-free','--print','Offline fixture only; do not run tools.'];
    const result=spawnSync(process.execPath,args,{cwd:plugin,env,encoding:'utf8',timeout:40000,maxBuffer:4*1024*1024});assert.ifError(result.error);
    const output=result.stdout+result.stderr;assert.doesNotMatch(output,/Failed to load extension/);
    const entries=(await readFile(join(dir,'fetch.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)),posts=entries.filter(e=>e.method==='POST');
    assert.ok(entries.every(e=>e.network===false));
    if(continuity){assert.equal(result.status,0,output);assert.match(output,/OFFLINE_GENERAL_POOL_FIXTURE/);assert.deepEqual(posts.map(e=>e.model),['xingchen-agi/xing4.0-29b-a4b:free',...Array(n+1).fill('reflection/beam-free')]);}
    else if(n<models.length){assert.equal(result.status,0,output);assert.match(output,/OFFLINE_GENERAL_POOL_FIXTURE/);assert.equal(posts.length,n+1);assert.equal(posts[n].service,pairs[n][0]);}
    else{assert.match(output,/paused/i);assert.equal(posts.length,models.length);}
    launches.push({index:n,exitCode:result.status,fixturePosts:posts.length,paused:continuity?false:n===models.length,stdout:result.stdout,stderr:result.stderr});
   }
   const saved=JSON.parse(await readFile(configFile));if(continuity){assert.equal(saved.rotation.paused,false);assert.equal(saved.config.cycles,0);assert.equal(saved.policyVersion,3);assert.deepEqual(saved.barriers,{});assert.ok(saved.modelBarriers[models[0]].until);}else{assert.equal(saved.rotation.paused,true);assert.equal(saved.rotation.completed,1);}
   rows.push({localPeers,mixed,continuity,launches,rotation:saved.rotation,socketNetwork:false});
  }
  return rows;
 }finally{await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),continuity=args.includes('--continuity'),root=args.find(a=>a!=='--continuity')??fileURLToPath(new URL('../',import.meta.url));
 console.log(JSON.stringify({node:process.version,cases:await verifyGeneralLoader(root,{continuity})},null,2));
}
