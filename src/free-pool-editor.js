import { clean } from './catalog-report.js';
import { thinkingProfile } from './models.js';
import { freePoolDefaults, rotationDefaults, poolKey, parsePoolKey, schedulingMode } from './free-pool.js';
import { secondsToMs } from './ovh-pool-editor.js';
import { createPoolStatusViewer } from './pool-activity.js';
const identity=m=>JSON.stringify([m?.provider,m?.id]);

/** Draft-only until reviewed atomic Apply. No catalog refresh or inference. */
export async function editFreePool(pool,pi,ctx){
  if(!ctx.hasUI||!['select','confirm','input'].every(k=>typeof ctx.ui?.[k]==='function'))return pool.report()+'\nEditing requires the Pi UI.';
  await pool.changes;
  const initial=pool.config,changes=pool.changes,before=identity(ctx.model);
  let draft=structuredClone(initial),restart=false,selectPrimary=false,saved=false,schedulingChosen=false;
  function boundary(){
    if(pool.shutdown.signal.aborted||pool.busy||ctx.isIdle?.()===false)throw Error('Pool must be idle and open');
    if(pool.config!==initial||pool.changes!==changes||identity(ctx.model)!==before)throw Error('Settings or active model changed; reopen the editor');
  }
  async function order(){
    const selected=[];
    for(;;){
      boundary();const available=pool.eligible(),rows=new Map(available.filter(m=>!selected.includes(poolKey(m))).map(m=>[`${clean(m.provider)} / ${clean(m.id)}`,poolKey(m)]));
      if(rows.size!==available.length-selected.filter(k=>available.some(m=>poolKey(m)===k)).length)throw Error('Ambiguous model labels');
      const options=[...rows.keys(),...(selected.length>=2?['Use this order']:[]),...(selected.length?['Undo last']:[]),'Back'];
      const value=await ctx.ui.select(`Free pool — choose position ${selected.length+1}\nAll eligible chat models; provider availability is not live-certified.`,options);boundary();
      if(value===undefined||value==='Back')return;
      if(value==='Undo last'){selected.pop();continue;}
      if(value==='Use this order'){
        if(!pool.installed&&!schedulingChosen)draft.scheduling='auto';
        draft.models=selected;draft.weights=Object.fromEntries(selected.map(k=>[k,draft.weights[k]??(parsePoolKey(k).service==='ovh'?2:1)]));
        draft.thinking=Object.fromEntries(selected.map(k=>[k,draft.thinking[k]??'default']));restart=true;return;
      }
      if(!rows.has(value))throw Error('Unknown model selection');selected.push(rows.get(value));
    }
  }
  async function perModel(field){
    for(;;){
      const rows=new Map(draft.models.map(k=>[`${clean(k)} — ${field==='weights'?draft.weights[k]:draft.thinking[k]}`,k]));
      const choice=await ctx.ui.select(field==='weights'?'Requests per visit (not rate limits)':'Per-model native thinking',[...rows.keys(),'Back']);boundary();
      if(choice===undefined||choice==='Back')return;const key=rows.get(choice);if(!key)throw Error('Unknown model selection');
      if(field==='weights'){
        const max=parsePoolKey(key).service==='ovh'?2:100;
        const raw=await ctx.ui.input(`Requests per visit: integer 1–${max}. Provider cooldowns still apply.`,String(draft.weights[key]));boundary();
        if(raw===undefined)continue;if(!/^\d{1,3}$/.test(raw.trim())||Number(raw)<1||Number(raw)>max){ctx.ui.notify?.(`Enter 1–${max}.`,'warning');continue;}
        draft.weights[key]=Number(raw);restart=true;
      }else{
        const entry=pool.catalog.state.entries[key];if(!entry)throw Error('Missing model evidence');
        const modes=new Map([['Provider default','default'],['Follow Pi','auto'],...Object.keys(thinkingProfile(entry,pool.catalog.state).choices).map(m=>[`Native: ${m}`,m])]);
        const mode=await ctx.ui.select('Choose advertised thinking',[...modes.keys(),'Back']);boundary();
        if(mode===undefined||mode==='Back')continue;if(!modes.has(mode))throw Error('Unknown thinking selection');draft.thinking[key]=modes.get(mode);
      }
    }
  }
  try{
    for(;;){
      boundary();
      const toggle=`Pool: ${draft.enabled?'ON':'OFF'} — toggle`,scheduling=`Scheduling: ${draft.scheduling} (${schedulingMode(draft)})`,cycles=`Cycles: ${draft.cycles||'continuous'}`;
      const wait=`Readiness wait: ${draft.maxWaitMs/1000}s`,response=`Response-start limit: ${draft.responseStartTimeoutMs/1000}s`,primary=`Select first model on Apply: ${selectPrimary?'Yes':'No'}`;
      const rr=schedulingMode(draft)==='round-robin';
      const options=['Edit model order','Edit per-model thinking',...(rr?['Edit requests per visit']:[]),toggle,scheduling,...(rr?[cycles]:[]),wait,response,primary,'Restart rotation on Apply','Preview draft','Apply settings','Reset draft','Cancel'];
      const choice=await ctx.ui.select(`Free pool — settings\n${draft.models.length} selected; saved rotation ${pool.rotation.paused?'PAUSED':'active'}. Changes are drafts until Apply.`,options);boundary();
      if(choice===undefined||choice==='Cancel')return 'Free pool editing cancelled; saved settings and active model kept.';
      if(!options.includes(choice))throw Error('Unknown settings choice');
      if(choice==='Edit model order'){await order();continue;}
      if(choice==='Edit per-model thinking'){await perModel('thinking');continue;}
      if(choice==='Edit requests per visit'){await perModel('weights');continue;}
      if(choice===toggle){draft.enabled=!draft.enabled;continue;}
      if(choice===primary){selectPrimary=!selectPrimary;continue;}
      if(choice===scheduling){const value=await ctx.ui.select('Scheduling mode',['auto','priority','round-robin']);boundary();if(value!==undefined){if(!['auto','priority','round-robin'].includes(value))throw Error('Unknown scheduling');draft.scheduling=value;schedulingChosen=true;if(schedulingMode(draft)==='priority')draft.cycles=0;restart=true;}continue;}
      if(choice===cycles){
        const value=await ctx.ui.input('Cycle allowance: 0 = continuous, 1–10000 = finite scheduling passes. Applies to round robin.',String(draft.cycles));boundary();
        if(value!==undefined){if(!/^\d{1,5}$/.test(value.trim())||Number(value)>10000){ctx.ui.notify?.('Enter 0–10000.','warning');continue;}draft.cycles=Number(value);restart=true;}continue;
      }
      if(choice===wait||choice===response){
        const key=choice===wait?'maxWaitMs':'responseStartTimeoutMs',max=choice===wait?60:300;
        const value=await ctx.ui.input(`Seconds: 0–${max}. 0 ${choice===wait?'does not wait':'disables the response-start limit'}.`,String(draft[key]/1000));boundary();
        if(value!==undefined){const ms=secondsToMs(value,max);if(ms===null){ctx.ui.notify?.('Invalid duration.','warning');continue;}draft[key]=ms;}continue;
      }
      if(choice==='Restart rotation on Apply'){restart=await ctx.ui.confirm('Restart allowance on Apply?','This reauthorizes finite visits from the beginning, but does NOT refund quota or clear provider cooldowns.');boundary();continue;}
      if(choice==='Reset draft'){if(await ctx.ui.confirm('Reset draft?','Pool OFF, clear draft list and limits. Review and Apply still required. No quota is reset.')){boundary();draft=freePoolDefaults();restart=true;selectPrimary=false;}continue;}
      const description=[`Pool: ${draft.enabled?'ON':'OFF'}; scheduling: ${schedulingMode(draft)}; cycles: ${draft.cycles||'continuous'}.`,
        ...draft.models.map((k,i)=>`${i+1}. ${clean(k)} × ${draft.weights[k]}; thinking ${clean(draft.thinking[k])}`),
        `Restart rotation: ${restart||!pool.installed?'YES (new allowance)':'NO (preserve position and spent allowance)'}.`,
        `Active model: ${selectPrimary?'select first through Pi':'keep unchanged'}.`,
        `Readiness: ${draft.maxWaitMs/1000}s; response-start: ${draft.responseStartTimeoutMs/1000}s.`,
        'PROVIDER ROUTING CONSENT: conversation and tool results may be sent to every selected provider, each with its own data policy.',
        'Weights are NOT rate limits. Skipped visits count toward cycle completion but send nothing. A crash/cancel after durable reservation can consume a visit without an HTTP send.',
        'Finite cycles pause rather than silently resetting. Rotation occurs only at safe request boundaries. This editor/preview sends no inference.'].join('\n');
      const plan=pool.preview.call({config:draft,rotation:restart||!pool.installed?rotationDefaults():pool.rotation});
      if(choice==='Preview draft'){
        if(typeof ctx.ui.custom==='function')await ctx.ui.custom((tui,_t,_k,done)=>createPoolStatusViewer(description+'\n\n'+plan,{tui,done,title:'Free pool — draft preview'}));
        else ctx.ui.notify?.(description+'\n\n'+plan,'info');continue;
      }
      let approved=typeof ctx.ui.custom==='function'?await ctx.ui.custom((tui,_t,_k,done)=>createPoolStatusViewer(description+'\n\n'+plan,{tui,done,confirm:true,title:'Apply free pool and provider routing?'})):undefined;
      if(approved===undefined)approved=await ctx.ui.confirm('Apply free pool and provider routing?',description+'\n\n'+plan);
      if(approved!==true)return 'Free pool editing cancelled; saved settings and active model kept.';
      boundary();const result=await pool.saveDraft(draft,initial,{restart:restart||!pool.installed,consent:true});saved=true;
      if(selectPrimary){
        if(pool.config!==result||identity(ctx.model)!==before||ctx.isIdle?.()===false||pool.shutdown.signal.aborted)throw Error('Session changed after saving; model kept');
        const target=pool.eligible().find(m=>poolKey(m)===result.models[0]);if(!target)throw Error('First model is unavailable');
        if(!await pi.setModel(target))throw Error('Pi refused first model');if(identity(ctx.model)!==identity(target))throw Error('Active model changed during selection');
      }
      return 'Free pool settings saved. '+(selectPrimary?'First model selected through Pi.':'Active model kept.');
    }
  }catch(e){return (saved?'Settings saved, but model selection failed: ':'Free pool unchanged: ')+clean(e.message||e);}
}
