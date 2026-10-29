// Offline regression for the actual bundled Pi CLI, not --list-models.
// The initial run has no prompt; later runs use display-only slash commands.
// Metadata comes from local fixtures; all POSTs and sockets are blocked.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const preload = `
import { readFileSync, appendFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Socket } from 'node:net';
// Pi initializes its own Undici fetch. Pin our fixture adapter across that setup.
Socket.prototype.connect = function () {
 appendFileSync(process.env.LOCAL_LOADER_LOG, JSON.stringify({method:'CONNECT',url:'blocked socket',allowed:false,network:false}) + '\\n');
 throw Error('All sockets forbidden in offline loader regression');
};
const mapping = {
 'https://api.kilo.ai/api/gateway/models': 'kilo',
 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models': 'ovh-models',
 'https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2': 'ovh-catalog',
};
const fixtureFetch = async (input, init = {}) => {
 const url = String(input instanceof Request ? input.url : input);
 const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
 const parsed = new URL(url);
 const pages = parsed.origin + parsed.pathname === 'https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json';
 const allowed = method === 'GET' && (pages || !!mapping[url]);
 appendFileSync(process.env.LOCAL_LOADER_LOG, JSON.stringify({method,url,allowed,network:false}) + '\\n');
 if (!allowed) throw Error('Network and inference forbidden in offline loader regression');
 if (pages) return new Response(null, {status:503});
 return new Response(gunzipSync(readFileSync(process.env.LOCAL_LOADER_FIXTURES + '/' + mapping[url] + '.json.gz')), {headers:{'content-type':'application/json'}});
};
Object.defineProperty(globalThis, 'fetch', {configurable:true,get:()=>fixtureFetch,set:()=>{}});
`;

// This temporary second extension exercises enabled production pool helpers inside
// the real host's module bridge. Its stream is a local fixture, NOT inference.
const probe = `
import assert from 'node:assert/strict';
import { Catalog } from './src/catalog.js';
import { registrations } from './src/models.js';
import { OvhPool } from './src/ovh-pool.js';
import { poolStream, POOL_REQUEST } from './src/ovh-pool-stream.js';
import { normalizeContext, createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
export default async function () {
 const catalog = new Catalog({fetch:globalThis.fetch}); await catalog.refresh();
 const pool = new OvhPool({catalog,getPiLevel:()=> 'low'});
 assert.equal(pool.config.enabled, false);
 await pool.configure('set',['gpt-oss-120b','gpt-oss-20b']);
 await pool.configure('on');
 const models = new Map(registrations(catalog.state,'ovh').map(m=>[m.id,{...m,provider:'free-ovh'}]));
 const source=models.get('gpt-oss-20b');
 const context=normalizeContext({systemPrompt:'Offline loader fixture',messages:[{role:'user',content:'Offline fixture only',timestamp:1}]});
 let calls=0, handoffs=0;
 const stream=poolStream({pool,model:source,context,options:{reasoning:'low'},
  onHandoff:async(from,to)=>{assert.equal(from.id,source.id);assert.equal(to.id,'gpt-oss-120b');handoffs++;},
  dispatch:(model,ctx)=>{
   calls++; assert.equal(ctx,context); assert.equal(model.id,'gpt-oss-120b');
   const s=createAssistantMessageEventStream();
   const message={role:'assistant',content:[{type:'text',text:'OFFLINE_FIXTURE_NOT_INFERENCE'}],stopReason:'stop',api:model.api,provider:model.provider,model:model.id,timestamp:1};
   s.push({type:'done',reason:'stop',message});s.end(message);return s;
  }});
 for await (const _ of stream) {}
 const result=await stream.result();
 assert.equal(result.stopReason,'stop',result.errorMessage);
 assert.equal(result.model,'gpt-oss-120b');assert.equal(calls,1);assert.equal(handoffs,1);
 // A one-second fixture budget tolerates host compilation/scheduling; it does
 // not change the production default or its configured response-start policy.
 await pool.saveDraft({...pool.config,responseStartTimeoutMs:1000});
 const sends=[];
 const timed=poolStream({pool,model:models.get('gpt-oss-120b'),context,options:{reasoning:'low'},
  onHandoff:async(from,to)=>{assert.equal(from.id,'gpt-oss-120b');assert.equal(to.id,'gpt-oss-20b');},
  dispatch:(model,ctx,options)=>{
   options[POOL_REQUEST].begin();pool.started(model.id);sends.push(model.id);
   const s=createAssistantMessageEventStream();
   if(sends.length===1)return s; // intentionally silent local SDK fixture
   const message={role:'assistant',content:[{type:'text',text:'OFFLINE_TIMEOUT_FIXTURE'}],stopReason:'stop',api:model.api,provider:model.provider,model:model.id,timestamp:1};
   s.push({type:'done',reason:'stop',message});s.end(message);return s;
  }});
 for await(const _ of timed){}
 const timedResult=await timed.result();assert.equal(timedResult.stopReason,'stop',timedResult.errorMessage);
 assert.deepEqual(sends,['gpt-oss-120b','gpt-oss-20b']);assert.equal(pool.quota.describe('gpt-oss-120b').remaining,1);
 pool.close();
 console.error('LOCAL_LOADER_TIMEOUT_HELPERS_PASS');
 console.error('LOCAL_LOADER_POOL_HELPERS_PASS');
}
`;

export async function verifyLocalLoader(projectRoot, { negativeControl = false } = {}) {
 const root=resolve(projectRoot);
 const entry=fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
 const cli=join(dirname(entry),'bundle/cli.js');
 const hostNodeModules=resolve(dirname(entry),'../../..');
 const temp=await mkdtemp(join(tmpdir(),'pi-local-loader-'));
 const rows=[];
 try {
  await writeFile(join(temp,'preload.mjs'),preload);
  for (const localPeers of [false,true]) for (const enabled of [false,true]) {
   const name=(localPeers?'local-peers':'host-only')+'-pool-'+(enabled?'on':'off');
   const work=join(temp,name),plugin=join(work,'extension'),agent=join(work,'agent');
   for (const dir of [plugin,join(work,'home'),join(agent,'free-catalog')]) await mkdir(dir,{recursive:true});
   for (const file of ['index.js','package.json','src']) await cp(join(root,file),join(plugin,file),{recursive:true});
   await writeFile(join(plugin,'loader-probe.js'),probe);
   if (localPeers) await symlink(hostNodeModules,join(plugin,'node_modules'),'dir');
   if (enabled) await writeFile(join(agent,'free-catalog/ovh-pool.json'),JSON.stringify({schemaVersion:1,enabled:true,models:['gpt-oss-120b','gpt-oss-20b'],maxWaitMs:0}));
   const env={PATH:process.env.PATH,HOME:join(work,'home'),PI_CODING_AGENT_DIR:agent,
    XDG_CONFIG_HOME:join(work,'config'),XDG_DATA_HOME:join(work,'data'),XDG_CACHE_HOME:join(work,'cache'),
    LANG:'C.UTF-8',NO_COLOR:'1',PI_SKIP_VERSION_CHECK:'1',
    LOCAL_LOADER_LOG:join(work,'fetch.jsonl'),LOCAL_LOADER_FIXTURES:join(root,'test/fixtures')};
   // Prove the missing-peer layout is real, rather than leaking source dependencies.
   const resolution=spawnSync(process.execPath,['--input-type=module','-e',"console.log(import.meta.resolve('@earendil-works/pi-ai/utils/estimate'))"],{cwd:plugin,env,encoding:'utf8',timeout:10000});
   assert.equal(resolution.status===0,localPeers,`Physical SDK resolution is wrong: ${name}: ${resolution.stderr}`);
   const args=['--import',join(temp,'preload.mjs'),cli,'--offline','-ne','-ns','-np','--no-themes','-nc','--no-mcp','--no-session','-e',join(plugin,'index.js'),'-e',join(plugin,'loader-probe.js'),'--print'];
   const p=spawnSync(process.execPath,args,{cwd:plugin,env,encoding:'utf8',timeout:40000,maxBuffer:4*1024*1024});
   assert.ifError(p.error);
   const output=p.stdout+p.stderr;
   const expectedFailure=negativeControl&&!localPeers;
   assert.equal(p.status,expectedFailure?1:0,`${name}: ${output}`);
   if (expectedFailure) assert.match(output,/Cannot find module '@earendil-works\/pi-ai\/utils\/estimate'/);
   else {
    assert.doesNotMatch(output,/Failed to load extension/);
    assert.match(output,/LOCAL_LOADER_POOL_HELPERS_PASS/);
    assert.match(output,/LOCAL_LOADER_TIMEOUT_HELPERS_PASS/);
   }
   const displayControls=[];
   if (!expectedFailure) for (const counts of [false,true]) {
    const command='/free-footer counts '+(counts?'on':'off');
    const display=spawnSync(process.execPath,[...args,command],{cwd:plugin,env,encoding:'utf8',timeout:40000,maxBuffer:4*1024*1024});
    assert.ifError(display.error);assert.equal(display.status,0,`${name} ${command}: ${display.stdout}${display.stderr}`);
    assert.doesNotMatch(display.stdout+display.stderr,/Failed to load extension/);
    const preferences=JSON.parse(await readFile(join(agent,'free-catalog/ui.json'),'utf8'));
    assert.deepEqual(preferences,{footer:'default',chatCounts:counts});
    displayControls.push({command,exitCode:display.status,preferences,stdout:display.stdout,stderr:display.stderr});
   }
   const requests=await readFile(join(work,'fetch.jsonl'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
   const fetchLog=requests.trim()?requests.trim().split('\n').map(s=>JSON.parse(s)):[];
   assert.ok(fetchLog.every(r=>r.allowed&&r.method==='GET'&&r.network===false));
   if (!expectedFailure) assert.ok(fetchLog.length>=7,`Fixture adapter was bypassed: ${name}`);
   rows.push({name,localPeers,persistedPoolEnabled:enabled,physicalSDKResolvable:resolution.status===0,
    exitCode:p.status,expectedFailure,displayControls,responseTimeoutProbePassed:output.includes('LOCAL_LOADER_TIMEOUT_HELPERS_PASS'),poolHelperProbePassed:output.includes('LOCAL_LOADER_POOL_HELPERS_PASS'),
    requests:fetchLog,metadataFixtureRequests:fetchLog.length,nonGETAttempts:fetchLog.filter(r=>r.method!=='GET').length,
    stdout:p.stdout,stderr:p.stderr});
  }
  return rows;
 } finally { await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const rows=await verifyLocalLoader(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)),{negativeControl:process.argv.includes('--negative-control')});
 console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cases:rows},null,2));
}
