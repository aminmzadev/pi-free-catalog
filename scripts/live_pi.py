"""Opt-in real Pi integration tests. Default tools stay ON. Isolated HOME, no credentials.
Set PI_NODE, PI_CLI, PI_TEST_DISPATCHER and FREE_TEST_DIR. Run catalog.mjs first.
No external test libraries required. The separate wire preload enforces free-only calls.
"""
import pathlib,os,json,subprocess,concurrent.futures,time,datetime,secrets,hashlib,signal,re,shutil,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=pathlib.Path(os.environ['FREE_TEST_DIR']).resolve();P.mkdir(parents=True,exist_ok=True)
NODE=pathlib.Path(os.environ['PI_NODE']);CLI=pathlib.Path(os.environ['PI_CLI'])
NORMAL='In one short sentence, what is 17 multiplied by 19?'
TOOLS="""Use the actual read, write, edit, bash tools, in that order. Work only inside the current directory. Do not access network, credentials, environment variables or files outside it.
Read fixture.txt with read. Write result.txt with write, exactly two lines: stage=raw and TOKEN=<the token from fixture.txt>.
Use edit to replace stage=raw with stage=done. Use bash to run python3 verify.py. Do not alter fixture.txt or verify.py. Do not substitute bash for the other three tools.
After verification succeeds answer exactly: DONE <TOKEN> <sha256 printed by verifier>."""
def entries(x):return [str(ROOT/'index.js')]
def functional_home(x,blank_authorization=False):return P/'homes'/x['name']
def envfor(home,run):
 agent=home/'.pi/agent';agent.mkdir(parents=True,exist_ok=True)
 settings=json.loads((agent/'settings.json').read_text()) if (agent/'settings.json').exists() else {}
 settings.update({'retry':{'enabled':False,'maxRetries':0},'compaction':{'enabled':False},'quietStartup':True})
 temporary=agent/('settings-'+secrets.token_hex(8)+'.tmp');temporary.write_text(json.dumps(settings));temporary.replace(agent/'settings.json')
 e={'PATH':str(NODE.parent)+':/usr/local/bin:/usr/bin:/bin','HOME':str(home),'LANG':'C.UTF-8','TERM':'dumb','CI':'1','NO_COLOR':'1','PI_CODING_AGENT_DIR':str(agent),'XDG_CACHE_HOME':str(home/'.cache'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share'),'PI_SKIP_VERSION_CHECK':'1','AUDIT_ROOT':str(P),'AUDIT_RUN_DIR':str(run),'NODE_OPTIONS':'--import='+str(ROOT/'scripts/wire.mjs'),'PI_TEST_DISPATCHER':os.environ['PI_TEST_DISPATCHER']}
 return e

def slugof(x):return x['kind']+'--'+x['name'].replace('@','').replace('/','--')
def run(job):
 x=job['item'];kind=job['mode'];attempt=job.get('attempt',1);slug=slugof(x);ident=job.get('id') or secrets.token_hex(4);
 import base64
 cooldown=P/('cooldown-'+job['service']+'-'+base64.urlsafe_b64encode(job['model'].encode()).decode().rstrip('=')+'.json')
 if cooldown.exists():
  wait=json.loads(cooldown.read_text()).get('until',0)/1000-time.time()
  if wait>0: time.sleep(min(wait+0.2,180))
 run=P/'inference'/slug/ident
 if run.exists():run.rename(run.with_name(ident+'-previous-'+secrets.token_hex(4)))
 run.mkdir(parents=True,exist_ok=True);case=run/'case';case.mkdir(exist_ok=True);home=pathlib.Path(job['home_override']) if job.get('home_override') else functional_home(x,job.get('blank_authorization',False));
 if job.get('blank_authorization'):
  (home/'.pi/agent/models.json').write_text(json.dumps({'providers':{job['provider']:{'headers':{'Authorization':''}}}},indent=2))
 token=secrets.token_hex(12);fixture='TOKEN='+token+'\n';expected=['stage=done','TOKEN='+token]
 verifier="import pathlib,hashlib,json\np=pathlib.Path(__file__).parent/'result.txt'\nb=p.read_bytes()\nassert b.decode('utf-8').splitlines()=="+repr(expected)+", 'Wrong file contents'\nprint(json.dumps({'verified':True,'sha256':hashlib.sha256(b).hexdigest()}))\n"
 (case/'fixture.txt').write_text(fixture);(case/'verify.py').write_text(verifier);(case/'verify.py').chmod(0o444);prompt=NORMAL if kind=='normal' else TOOLS;(case/'prompt.txt').write_text(prompt)
 e=envfor(home,run)
 if job.get('public_env'):e['OPENCODE_API_KEY']='public'
 cmd=[str(NODE),str(CLI),'--no-extensions','--no-skills','--no-context-files','--no-mcp','--no-prompt-templates','--no-session','--mode','json','-p']
 if job.get('use_installed'):
  cmd.remove('--no-extensions')
 else:
  for entry in entries(x):cmd+=['-e',entry]
 cmd+=['--provider',job['provider'],'--model',job['model']]
 if job.get('thinking'):cmd+=['--thinking',job['thinking']]
 cmd.append(prompt)
 (run/'command.json').write_text(json.dumps({'command':cmd,'cwd':str(case),'environment_keys':sorted(e),'public_literal_env':job.get('public_env',False)},indent=2));deadline=job.get('deadline',90 if kind=='normal' else 180);started=datetime.datetime.now(datetime.timezone.utc).isoformat();start=time.monotonic();timeout=False;limited=False;op=run/'stdout.jsonl';ep=run/'stderr.txt'
 with op.open('wb') as out,ep.open('wb') as err:
  pr=subprocess.Popen(cmd,cwd=case,env=e,stdout=out,stderr=err,start_new_session=True)
  while True:
   try:code=pr.wait(timeout=min(2,max(.05,deadline-(time.monotonic()-start))));break
   except subprocess.TimeoutExpired:
    if time.monotonic()-start>=deadline:timeout=True;break
    if op.stat().st_size>5000000 or op.read_bytes().count(b'"type":"tool_execution_start"')>=12:limited=True;break
  if timeout or limited:
   os.killpg(pr.pid,signal.SIGTERM)
   try:pr.wait(timeout=3)
   except subprocess.TimeoutExpired:os.killpg(pr.pid,signal.SIGKILL);pr.wait()
   code='timeout' if timeout else 'tool_budget_limit'
  # Metadata/proxy/CLI subprocesses never survive their bounded test group.
  try:os.killpg(pr.pid,signal.SIGTERM)
  except ProcessLookupError:pass
 raw=op.read_text(errors='replace');stderr=ep.read_text(errors='replace');messages=[];starts={};ends=[];bad=0;declared=[];retries=[]
 for line in raw.splitlines():
  try:v=json.loads(line)
  except Exception:bad+=bool(line.strip());continue
  if v.get('type')=='message_end':
   m=v.get('message',{})
   if m.get('role')=='assistant':messages.append(m)
   if m.get('role')=='system':declared=sorted(t.get('name','') for t in m.get('toolsAdded',[])) or declared
  if v.get('type')=='tool_execution_start':starts[v.get('toolCallId')]=v
  if v.get('type')=='tool_execution_end':
   t=dict(v);t['args']=starts.get(v.get('toolCallId'),{}).get('args',{});ends.append(t)
  if 'retry' in v.get('type',''):retries.append(v)
 last=messages[-1] if messages else {};answer=''.join(v.get('text','') for v in last.get('content',[]) if v.get('type')=='text');errors=[m.get('errorMessage','') for m in messages if m.get('stopReason') in ['error','aborted']];low='\n'.join(errors+[stderr]).lower();fallback='using custom model id' in low
 def pathok(a,f):
  try:return bool(a) and (case/a).resolve()==(case/f).resolve()
  except:return False
 checks={tool:any(t.get('toolName')==tool and not t.get('isError',False) and pathok(t.get('args',{}).get('path',''),fn) for t in ends) for tool,fn in [('read','fixture.txt'),('write','result.txt'),('edit','result.txt')]}
 content=(case/'result.txt').read_bytes() if (case/'result.txt').exists() else None;sha=hashlib.sha256(content).hexdigest() if content is not None else None;file_ok=content is not None and content.decode(errors='replace').splitlines()==expected
 checks['bash']=bool(sha) and any(t.get('toolName')=='bash' and not t.get('isError',False) and 'verify.py' in t.get('args',{}).get('command','') and sha in json.dumps(t.get('result',{})) for t in ends)
 intact=(case/'fixture.txt').read_text()==fixture and (case/'verify.py').read_text()==verifier;scope=[]
 for t in ends:
  a=t.get('args',{}).get('path')
  if t.get('toolName') in ['read','write','edit'] and isinstance(a,str) and not (case/a).resolve().is_relative_to(case.resolve()):scope.append(a)
 complete=code==0 and last.get('stopReason') not in ['error','aborted','toolUse','pending'] and bool(messages);normal_ok=bool(re.search(r'(?<!\d)323(?!\d)',answer)) and complete;final_ok=bool(sha) and token in answer and sha in answer and complete;tools_ok=all(checks.values()) and file_ok and final_ok and intact and not scope
 wire=[]
 if (run/'wire.jsonl').exists():
  for line in (run/'wire.jsonl').read_text().splitlines():
   try:wire.append(json.loads(line))
   except:pass
 statuses=[t.get('status') for t in wire if t.get('method')=='POST' and t.get('model')==job['model']]
 if (normal_ok if kind=='normal' else tools_ok):status='PASS_NORMAL' if kind=='normal' else 'PASS_FOUR_TOOLS'
 elif any(t.get('blocked')=='audit-request-budget' for t in wire):status='AUDIT_REQUEST_BUDGET'
 elif fallback:status='UNREGISTERED_CUSTOM_FALLBACK'
 elif 'malformed server-sent event json' in low:status='SSE_JSON_ERROR'
 elif 'stream ended without finish_reason' in low:status='INCOMPLETE_STREAM'
 elif 'no endpoints found that support tool use' in low:status='TOOLS_NOT_SUPPORTED'
 elif 'reasoning is mandatory' in low:status='REASONING_REQUIRED'
 elif 'temporarily overloaded' in low or 'resourceexhausted' in low:status='UPSTREAM_CAPACITY'
 elif 429 in statuses or '429' in low or 'rate limit' in low or 'too many requests' in low:status='HTTP_429'
 elif 403 in statuses or '403' in low or 'freetiererror' in low:status='ACCESS_403'
 elif 401 in statuses or '401' in low:status='AUTH_401'
 elif 'no api key' in low or 'authentication' in low and not messages:status='AUTH_NOT_CONFIGURED'
 elif 'modelprotocolunsupported' in low or 'does not support this protocol' in low:status='PROTOCOL_UNSUPPORTED'
 elif timeout:status='TIMEOUT'
 elif limited:status='TOOL_OR_LOG_BUDGET_LIMIT'
 elif 400 in statuses or '400' in low:status='HTTP_400'
 elif kind=='tools' and all(checks.values()) and file_ok and final_ok and intact and scope:status='TOOLS_COMPLETE_SCOPE_VIOLATION'
 elif kind=='tools' and ends:status='PARTIAL_TOOL_WORKFLOW'
 elif answer.strip():status='OTHER_TEXT'
 elif code!=0 and not messages:status='LOAD_OR_SELECTION_ERROR'
 else:status='NO_COMPLETE_ANSWER'
 row={'id':ident,'extension':x['name'],'kind':x['kind'],'version':x.get('version'),'commit':x.get('commit'),'provider':job['provider'],'model':job['model'],'canonical_provider':job['service'],'mode':kind,'attempt':attempt,'phase':job.get('phase','plugin-comparison'),'thinking_requested':job.get('thinking','Pi default'),'public_literal_env':job.get('public_env',False),'blank_authorization_override':job.get('blank_authorization',False),'installed_package_discovery':job.get('use_installed',False),'started_utc':started,'seconds':round(time.monotonic()-start,2),'exit_code':code,'timeout':timeout,'budget_limit':limited,'status':status,'used_custom_model_fallback':fallback,'answer':answer,'stop_reason':last.get('stopReason'),'errors':errors,'stderr':stderr,'declared_tools':declared,'successful_tools':sorted(set(t.get('toolName','') for t in ends if not t.get('isError',False))),'tool_checks':checks,'file_correct':file_ok,'final_tool_answer_correct':final_ok,'fixtures_unchanged':intact,'file_scope_observations':scope,'tool_events':ends,'retry_events':retries,'invalid_jsonl_lines':bad,'observed_models':sorted(set(m.get('model','') for m in messages)),'fixture_token':token,'result_sha256':sha,'relative_run_path':str(run.relative_to(P)),'wire_http_statuses':statuses,'usage':{k:sum(m.get('usage',{}).get(k,0) for m in messages) for k in ['input','output','totalTokens']}}
 (run/'result.json').write_text(json.dumps(row,ensure_ascii=False,indent=2));print(json.dumps({k:row[k] for k in ['id','extension','model','mode','status','seconds','successful_tools','errors']},ensure_ascii=False),flush=True);return row

def batch(jobs,workers=2,outfile='inference-results.json'):
 path=P/outfile;results=json.loads(path.read_text()) if path.exists() else []
 with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
  fs=[ex.submit(run,j) for j in jobs]
  for f in concurrent.futures.as_completed(fs):results.append(f.result());path.write_text(json.dumps(results,ensure_ascii=False,indent=2))
 print('BATCH_DONE',len(jobs),flush=True);return results

if __name__=='__main__':
 snapshot=json.loads((P/'live-catalog.json').read_text());x={'kind':'local','name':'pi-free-catalog','path':str(ROOT),'version':json.loads((ROOT/'package.json').read_text())['version']}
 jobs=[]
 for entry in snapshot['entries'].values():
  if entry['classification']!='free' or not entry['listed'] or entry['type']!='chat' or entry['lifecycle']=='retired':continue
  service=entry['service'];ident='normal-'+service+'-'+hashlib.sha256(entry['id'].encode()).hexdigest()[:10]
  jobs.append({'item':x,'mode':'normal','id':ident,'phase':'all-free-models','service':'kilo' if service=='kilo' else 'opencode','provider':'free-'+service,'model':entry['id'],'home_override':str(P/'homes'/ident),'deadline':90})
 for service,model in [('kilo','poolside/laguna-s-2.1:free'),('kilo','reflection/beam-free'),('zen','mimo-v2.6-flash-free'),('zen','beam-free')]:
  ident='tools-'+service+'-'+hashlib.sha256(model.encode()).hexdigest()[:10]
  jobs.append({'item':x,'mode':'tools','id':ident,'phase':'four-default-tools','service':'kilo' if service=='kilo' else 'opencode','provider':'free-'+service,'model':model,'home_override':str(P/'homes'/ident),'deadline':180})
 for service,model,mode in [('kilo','reflection/beam-free','low'),('kilo','reflection/beam-free','high'),('kilo','poolside/laguna-s-2.1:free','instant'),('zen','beam-free','low'),('zen','beam-free','max'),('kilo','nvidia/nemotron-3.5-super-vl:free','instant')]:
  ident='thinking-'+service+'-'+mode+('-supervl' if 'super-vl' in model else '');home=P/'homes'/ident;folder=home/'.pi/agent/free-catalog';folder.mkdir(parents=True,exist_ok=True)
  (folder/'thinking.json').write_text(json.dumps({json.dumps([service,model],separators=(',',':')):mode}))
  jobs.append({'item':x,'mode':'normal','id':ident,'phase':'native-thinking','service':'kilo' if service=='kilo' else 'opencode','provider':'free-'+service,'model':model,'home_override':str(home),'deadline':90})
 for service in ['kilo','zen']:
  model='reflection/beam-free' if service=='kilo' else 'beam-free';ident='pi-thinking-'+service+'-low'
  jobs.append({'item':x,'mode':'normal','id':ident,'phase':'pi-thinking-flag','thinking':'low','service':'kilo' if service=='kilo' else 'opencode','provider':'free-'+service,'model':model,'home_override':str(P/'homes'/ident),'deadline':90})
 if '--pilot' in sys.argv:jobs=[next(j for j in jobs if j['provider']==p and 'laguna-s' in j['model'] or j['provider']==p and 'mimo-v2.6-flash' in j['model']) for p in ['free-kilo','free-zen']]
 if '--installed' in sys.argv:
  jobs=[j for j in jobs if j['mode']=='tools' and ('laguna-s' in j['model'] or 'mimo-v2.6-flash' in j['model'] or j['model']=='reflection/beam-free')]
  for j in jobs:j.update({'id':'packaged-'+j['id'],'use_installed':True,'home_override':str(P/'installed-home'),'phase':'packaged-installation'})
 prior=json.loads((P/'inference-results.json').read_text()) if (P/'inference-results.json').exists() else []
 done={r['id'] for r in prior};jobs=[j for j in jobs if j['id'] not in done]
 (P/'live-jobs.json').write_text(json.dumps(jobs,indent=2));batch(jobs,workers=1 if '--installed' in sys.argv else 3)
