"""Opt-in real Pi census / native classifier test; no credentials, no ordinary chat inference."""
import pathlib,os,json,subprocess,sys,signal
from cache_io import read_catalog
ROOT=pathlib.Path(__file__).resolve().parents[1];P=pathlib.Path(os.environ['FREE_TEST_DIR']);NODE=pathlib.Path(os.environ['PI_NODE']);CLI=pathlib.Path(os.environ['PI_CLI'])
mode='classifier' if '--classifier' in sys.argv else 'census';installed='--installed' in sys.argv
run=P/(mode+('-installed' if installed else ''));run.mkdir(parents=True,exist_ok=True)
home=P/'installed-home' if installed else run/'home';agent=home/'.pi/agent';agent.mkdir(parents=True,exist_ok=True)
e={'PATH':str(NODE.parent)+':/usr/local/bin:/usr/bin:/bin','HOME':str(home),'LANG':'C.UTF-8','TERM':'dumb','CI':'1','NO_COLOR':'1','PI_CODING_AGENT_DIR':str(agent),'PI_SKIP_VERSION_CHECK':'1','AUDIT_ROOT':str(P),'AUDIT_RUN_DIR':str(run),'NODE_OPTIONS':'--import='+str(ROOT/'scripts/wire.mjs'),'PI_TEST_DISPATCHER':os.environ['PI_TEST_DISPATCHER'],'FREE_TEST_OUTPUT':str(run/'result.json'),'FREE_TEST_CLASSIFIER':'1' if mode=='classifier' else '0'}
cmd=[str(NODE),str(CLI),'--no-skills','--no-context-files','--no-mcp','--no-prompt-templates','--no-session','--mode','json','-p']
if not installed:cmd+=['--no-extensions','-e',str(ROOT/'index.js')]
cmd+=['-e',str(ROOT/'scripts/observe-pi.js'),'--provider','free-test-bootstrap','--model','bootstrap','Metadata observer exits before chat inference.']
(run/'command.json').write_text(json.dumps({'command':cmd,'environment_keys':sorted(e)},indent=2))
with (run/'stdout.jsonl').open('w') as out,(run/'stderr.txt').open('w') as err:
 p=subprocess.Popen(cmd,cwd=run,env=e,stdout=out,stderr=err,start_new_session=True)
 try:code=p.wait(timeout=90)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=3);raise
assert code==0,(run/'stderr.txt').read_text()
d=json.loads((run/'result.json').read_text());print('Chat models:',len(d['models']),'Classifiers:',len(d['classifiers']),'Available chat:',len(d['available']))
state=read_catalog(agent/'free-catalog/catalog.json')
eligible=[e for e in state['entries'].values() if e['listed'] and e['classification']=='free' and e['lifecycle']!='retired']
expected={(('free-'+e['service']),e['id']) for e in eligible if e['type']=='chat'}
expected_classifiers={(('free-'+e['service']),e['id']) for e in eligible if e['type']=='classifier'}
assert {(m['provider'],m['id']) for m in d['models']}==expected
assert {(m['provider'],m['id']) for m in d['available']}==expected
assert {(m['provider'],m['id']) for m in d['classifiers']}==expected_classifiers
if mode=='classifier':assert d['classifierResult']['stopReason']=='stop' and d['classifierResult']['answers']['topic']['choice']=='math',d['classifierResult'];print('Native classifier: PASS')
print('Real Pi census: PASS')
