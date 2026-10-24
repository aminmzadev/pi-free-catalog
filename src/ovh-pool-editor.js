import { clean } from './catalog-report.js';
import { thinkingProfile } from './models.js';
import { recordKey } from './catalog.js';
import { createPoolStatusViewer } from './pool-activity.js';

export const CANCEL='Cancel — keep saved settings';
export const APPLY='Apply settings';
export const REVIEW='Apply OVH pool settings?';
export function secondsToMs(value,maximum=60){
 if(typeof value!=='string'||!/^\d{1,3}(?:\.\d{1,3})?$/.test(value.trim()))return null;
 const n=Math.round(Number(value.trim())*1000);return n>=0&&n<=maximum*1000?n:null;
}
const identity=m=>JSON.stringify([m?.provider,m?.id]);
const label=m=>`${clean(m.name||m.id)} — [${clean(m.id)}]`;

/** One draft, one review, one atomic configuration write. No network/model probing. */
export async function editOvhPool(pool,pi,ctx){
 if(!ctx.hasUI||!['select','confirm','input'].every(k=>typeof ctx.ui?.[k]==='function'))return pool.report()+'\nEditing requires the Pi UI; no settings changed.';
 await pool.changes;
 const initial=pool.config,changes=pool.changes,before=identity(ctx.model);
 let draft=structuredClone(initial),selectPrimary=false,saved=false;
 draft.thinking=Object.fromEntries(draft.models.map(id=>[id,pool.mode(id)]));
 const boundary=()=>{
  if(pool.shutdown.signal.aborted)throw Error('OVH pool is closed');
  if(ctx.isIdle?.()===false)throw Error('The agent must be idle');
  if(pool.config!==initial||pool.changes!==changes)throw Error('Pool changed while editing; reopen it');
  if(identity(ctx.model)!==before)throw Error('Active model changed while editing; reopen it');
 };
 async function order(){
  const selected=[];
  for(;;){
   boundary();const models=pool.eligible(),available=new Set(models.map(m=>m.id));
   if(selected.some(id=>!available.has(id)))throw Error('Draft selection is no longer eligible');
   const items=new Map(models.filter(m=>!selected.includes(m.id)).map(m=>[label(m),m.id]));
   if(items.size!==models.filter(m=>!selected.includes(m.id)).length)throw Error('Ambiguous model labels');
   const options=[...items.keys(),...(selected.length>=2?['Use this order']:[]),...(selected.length?['Undo last selection']:[]),'Back — keep draft order'];
   const choice=await ctx.ui.select(`OVH pool — choose priority ${selected.length+1}\n${selected.length} model(s) chosen. Nothing saved yet.`,options);
   boundary();if(choice===undefined||choice==='Back — keep draft order')return;
   if(!options.includes(choice))throw Error('Invalid model choice');
   if(choice==='Undo last selection'){selected.pop();continue;}
   if(choice==='Use this order'){
    draft.models=selected;draft.thinking=Object.fromEntries(selected.map(id=>[id,draft.thinking[id]??(initial.models.includes(id)?pool.mode(id):'default')]));return;
   }
   selected.push(items.get(choice));
  }
 }
 async function thinking(){
  for(;;){
   boundary();const rows=new Map(draft.models.map(id=>[`${clean(id)} — ${clean(draft.thinking[id]??pool.mode(id))}`,id]));
   const choice=await ctx.ui.select('OVH pool — per-model thinking\nChoose thinking for each pool model. Other preferences stay unchanged.',[...rows.keys(),'Back']);
   boundary();if(choice===undefined||choice==='Back')return;
   const id=rows.get(choice);if(!id)throw Error('Invalid thinking model');
   const entry=pool.catalog.state.entries[recordKey('ovh',id)];if(!entry)throw Error('Missing model metadata');
   const profile=thinkingProfile(entry,pool.catalog.state);
   const modes=new Map([['Provider default','default'],['Follow Pi level (auto)','auto'],...Object.keys(profile.choices).map(k=>[`Native: ${k}`,k])]);
   const mode=await ctx.ui.select(`OVH pool thinking — ${clean(id)}\nCurrent: ${draft.thinking[id]??pool.mode(id)}; choose a supported setting.`,[...modes.keys(),'Back']);
   boundary();if(mode===undefined||mode==='Back')continue;
   if(!modes.has(mode))throw Error('Invalid native thinking choice');draft.thinking[id]=modes.get(mode);
  }
 }
 try{
  for(;;){
   boundary();const toggle=`Pool: ${draft.enabled?'ON':'OFF'} — toggle`,wait=`Maximum wait: ${draft.maxWaitMs/1000} seconds`,response=`Response-start limit: ${draft.responseStartTimeoutMs?draft.responseStartTimeoutMs/1000+' seconds':'disabled'}`,primary=`Select primary on Apply: ${selectPrimary?'Yes':'No'}`;
   const options=['Edit model order','Edit per-model thinking',toggle,wait,response,primary,APPLY,'Reset draft',CANCEL];
   const choice=await ctx.ui.select(`OVH pool — configuration\n${draft.models.length} model(s) selected. Nothing is saved until Apply.`,options);
   boundary();if(choice===undefined||choice===CANCEL)return 'OVH pool editing cancelled; saved settings and active model unchanged.';
   if(!options.includes(choice))throw Error('Invalid editor choice');
   if(choice==='Edit model order'){await order();continue;}
   if(choice==='Edit per-model thinking'){await thinking();continue;}
   if(choice===toggle){draft.enabled=!draft.enabled;continue;}
   if(choice===primary){selectPrimary=!selectPrimary;continue;}
   if(choice===wait){
    let title='Wait for an available model: 0–60 seconds. 0 means do not wait.';
    for(;;){const text=await ctx.ui.input(title,String(draft.maxWaitMs/1000));boundary();if(text===undefined)break;const n=secondsToMs(text);if(n!==null){draft.maxWaitMs=n;break;}title='Invalid duration — enter 0 to 60 seconds, up to 3 decimal places';}continue;
   }
   if(choice===response){
    let title='Wait for response to start: 0–300 seconds. 0 disables this limit.';
    for(;;){
     const text=await ctx.ui.input(title,String(draft.responseStartTimeoutMs/1000));boundary();
     if(text===undefined)break;
     const n=secondsToMs(text,300);
     if(n!==null){draft.responseStartTimeoutMs=n;break;}
     title='Enter 0–300 seconds, up to 3 decimal places. 0 disables the limit.';
    }continue;
   }
   if(choice==='Reset draft'){
    if(await ctx.ui.confirm('Reset OVH pool draft?','Clear the draft and turn the pool OFF. Both waiting limits become zero. Apply is still required. Your active model and used quota stay unchanged.')){
     boundary();draft={schemaVersion:1,enabled:false,models:[],maxWaitMs:0,responseStartTimeoutMs:0,thinking:{}};selectPrimary=false;
    }continue;
   }
   if(draft.enabled&&draft.models.length<2){ctx.ui.notify?.('Select at least two eligible models before enabling the pool.','warning');continue;}
   if(selectPrimary&&!draft.models.length){ctx.ui.notify?.('Select a primary model first.','warning');continue;}
   const summary=`Model order and thinking:
${draft.models.map((id,i)=>`${i+1}. ${clean(id)}: ${clean(draft.thinking[id]??pool.mode(id))}`).join('\n')||'(empty)'}
Pool: ${initial.enabled?'ON':'OFF'} → ${draft.enabled?'ON':'OFF'}
Wait for an available model: ${initial.maxWaitMs/1000}s → ${draft.maxWaitMs/1000}s
Response-start limit: ${draft.responseStartTimeoutMs?draft.responseStartTimeoutMs/1000+'s':'disabled'}
Active Pi model: ${selectPrimary?'select free-ovh/'+draft.models[0]:'keep current model'}
The response-start limit stops at the first text, thinking or tool-call activity. A silent timed-out attempt may still use quota.
Each request must fit the chosen model. This editor sends no chat requests.`;
   let approved=typeof ctx.ui.custom==='function'
    ?await ctx.ui.custom((tui,_theme,_keys,done)=>createPoolStatusViewer(summary,{tui,done,confirm:true,title:REVIEW}))
    :undefined;
   // Hosts without a custom terminal surface may resolve it without mounting.
   // Our own Escape path explicitly returns false, so it never falls through.
   if(approved===undefined)approved=await ctx.ui.confirm(REVIEW,summary);
   if(approved!==true)return 'OVH pool editing cancelled; saved settings and active model unchanged.';
   boundary();const result=await pool.saveDraft(draft,initial);saved=true;
   if(selectPrimary){
    if(pool.config!==result||ctx.isIdle?.()===false||identity(ctx.model)!==before||pool.shutdown.signal.aborted)throw Error('Session changed after settings save; primary was not selected');
    const model=pool.eligible().find(m=>m.id===result.models[0]);if(!model)throw Error('Primary is no longer eligible');
    if(!await pi.setModel({...model,provider:'free-ovh'}))throw Error('Pi refused the primary model');
    if(ctx.model?.provider!=='free-ovh'||ctx.model?.id!==model.id)throw Error('Pi did not confirm the requested active model');
   }
   return 'OVH pool settings saved. '+(selectPrimary?'Primary selected through Pi.':'Active model kept.');
  }
 }catch(error){return (saved?'OVH pool settings were saved, but the remaining model selection failed: ':'OVH pool unchanged: ')+clean(error?.message||error);}
}
