// Data-only, one-way retirement of the removed provider. No routes or provider registration.
import assert from 'node:assert/strict';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const retiredSources = new Set(['zen','official','modelsdev','pi']);
export function retiredKey(key) {
  try { const v=JSON.parse(key); return Array.isArray(v)&&v.length===2&&v[0]==='zen'&&typeof v[1]==='string'&&JSON.stringify(v)===key; }
  catch { return false; }
}
export function migrateCatalogState(raw) {
  assert.ok(object(raw)&&raw.schemaVersion===1&&object(raw.sources)&&object(raw.entries),'Invalid saved catalog');
  const entries=Object.fromEntries(Object.entries(raw.entries).filter(([key,e])=>{
    if(e?.service!=='zen')return true;
    assert.ok(retiredKey(key)&&JSON.parse(key)[1]===e.id,'Invalid retired catalog identity');return false;
  }));
  for(const field of ['history','changes'])assert.ok(raw[field]===undefined||Array.isArray(raw[field]),'Invalid saved catalog history');
  return {...raw,entries,sources:Object.fromEntries(Object.entries(raw.sources).filter(([name])=>!retiredSources.has(name))),
    history:(raw.history||[]).filter(e=>e?.service!=='zen'),changes:(raw.changes||[]).filter(e=>e?.service!=='zen')};
}
export function migrateThinkingSelections(raw) {
  if(!object(raw))return {};
  return Object.fromEntries(Object.entries(raw).filter(([key])=>!retiredKey(key)));
}
/** Preserve remaining routing state. Membership changes require explicit review/restart;
 * merely loading never grants a fresh cycle, removes a remaining cooldown, or sends HTTP.
 */
export function migratePoolProvider(raw) {
  if(!object(raw)||!object(raw.config)||!Array.isArray(raw.config.models))return {value:raw,changed:false};
  const original=raw.config,removed=original.models.filter(retiredKey);
  const hasRetiredState=removed.length||Object.hasOwn(raw.barriers||{},'zen')||Object.keys(raw.modelBarriers||{}).some(retiredKey)||raw.cooldownEvidence?.some?.(e=>e?.service==='zen')||raw.approvedProviders?.includes?.('zen');
  if(!hasRetiredState)return {value:raw,changed:false};
  assert.equal(raw.schemaVersion,2);assert.equal(original.schemaVersion,2);
  assert.equal(typeof original.enabled,'boolean');assert.ok(original.models.length<=2000&&new Set(original.models).size===original.models.length);
  if(original.enabled)assert.ok(original.models.length>=2,'Invalid legacy enabled pool');
  const identities=original.models.map(key=>{const v=JSON.parse(key);assert.ok(Array.isArray(v)&&v.length===2&&['kilo','zen','ovh'].includes(v[0])&&typeof v[1]==='string'&&v[1].trim()===v[1]&&v[1].length>0&&v[1].length<=256&&!/[\x00-\x1f\x7f-\x9f]/.test(v[1])&&JSON.stringify(v)===key,'Invalid legacy identity');return v;});
  assert.deepEqual(raw.approvedProviders,[...new Set(identities.map(v=>v[0]))].sort(),'Invalid legacy routing consent');
  for(const field of ['weights','thinking'])assert.ok(object(original[field])&&Object.keys(original[field]).every(k=>original.models.includes(k)),'Invalid legacy per-model settings');
  for(const [i,key]of original.models.entries()){
    const w=original.weights[key]??(identities[i][0]==='ovh'?2:1),mode=original.thinking[key]??'default';
    assert.ok(Number.isSafeInteger(w)&&w>=1&&w<=(identities[i][0]==='ovh'?2:100),'Invalid legacy weight');
    assert.ok(typeof mode==='string'&&mode.trim()&&mode.length<=128,'Invalid legacy thinking');
  }
  const rotation=raw.rotation;
  assert.ok(object(rotation)&&typeof rotation.paused==='boolean'&&['cursor','used','completed'].every(k=>Number.isSafeInteger(rotation[k])&&rotation[k]>=0)&&rotation.cursor<Math.max(1,original.models.length)&&rotation.used<(original.weights[original.models[rotation.cursor]]??(identities[rotation.cursor]?.[0]==='ovh'?2:1))&&rotation.completed<=1000000000,'Invalid legacy rotation');
  if(original.cycles)assert.ok(rotation.completed<=original.cycles&&(rotation.completed!==original.cycles||rotation.paused),'Invalid legacy exhausted rotation');
  if(Object.hasOwn(raw.barriers||{},'zen'))assert.ok(object(raw.barriers.zen)&&Number.isSafeInteger(raw.barriers.zen.until)&&raw.barriers.zen.until>=0,'Invalid retired cooldown');
  for(const [key,b]of Object.entries(raw.modelBarriers||{}))if(retiredKey(key))assert.ok(object(b)&&Number.isSafeInteger(b.until)&&b.until>=0,'Invalid retired model cooldown');
  const models=original.models.filter(k=>!retiredKey(k));
  let cursor=models.indexOf(original.models[rotation.cursor]),used=rotation.used;
  if(cursor<0){cursor=0;used=0;for(let n=1;n<=original.models.length;n++){const index=models.indexOf(original.models[(rotation.cursor+n)%original.models.length]);if(index>=0){cursor=index;break;}}}
  const filterMap=m=>Object.fromEntries(Object.entries(m).filter(([key])=>!retiredKey(key)));
  const config={...original,models,weights:filterMap(original.weights),thinking:filterMap(original.thinking),...(removed.length?{enabled:false}:{})};
  return {changed:true,value:{...raw,config,approvedProviders:[...new Set(models.map(k=>JSON.parse(k)[0]))].sort(),
    rotation:{...rotation,cursor,used,...(removed.length?{paused:true}:{})},
    modelBarriers:raw.modelBarriers===undefined?undefined:filterMap(raw.modelBarriers),
    barriers:raw.barriers===undefined?undefined:Object.fromEntries(Object.entries(raw.barriers).filter(([s])=>s!=='zen')),
    cooldownEvidence:Array.isArray(raw.cooldownEvidence)?raw.cooldownEvidence.filter(e=>e?.service!=='zen'):raw.cooldownEvidence,
    removalReviewRequired:!!raw.removalReviewRequired||!!removed.length}};
}
