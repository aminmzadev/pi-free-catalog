// Explicit v1 -> v2 data migration, not a rulesHash bypass.
// The only accepted legacy rules are the unchanged, published 0.1.7 production rules.
import assert from 'node:assert/strict';
import { migrateCatalogState } from './provider-removal.js';
import { validateState, summary } from './catalog.js';
import { canonical, sha256, dataHash, seal, validateSnapshot, SOURCE_NAMES, timestamp } from './snapshot-contract.js';
export const LEGACY_URL='https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json';
export const LEGACY_RULES_HASH='5cf7d78a8622732cc69126b186ba814b5dc55b5458079e7323af6aaff157987d';
export function migrateLegacySnapshot(raw,{expectedRules,now=Date.now()}={}) {
  assert.ok(expectedRules,'Missing destination rules fingerprint');
  assert.equal(raw?.schemaVersion,1,'Not a legacy v1 snapshot');
  const exact=(value,fields,label)=>assert.deepEqual(Object.keys(value).sort(),fields.sort(),'Unexpected legacy '+label+' fields');
  exact(raw,['schemaVersion','generatedAt','producer','rulesHash','sources','catalog','summary','quality','integrity'],'snapshot');
  exact(raw.catalog,['entries','changes','history'],'catalog');
  exact(raw.summary,['kilo','zen','ovh'],'summary');
  exact(raw.quality,['status','freshSources','retainedSources','largeChanges','largeChangesApproved'],'quality');
  exact(raw.integrity,['algorithm','payloadHash'],'integrity');
  assert.equal(raw.rulesHash,LEGACY_RULES_HASH,'Legacy rules migration was not reviewed');
  assert.equal(raw.integrity?.algorithm,'sha256');
  const payload={...raw};delete payload.integrity;
  assert.equal(raw.integrity.payloadHash,sha256(canonical(payload)),'Legacy snapshot integrity mismatch');
  assert.deepEqual(Object.keys(raw.sources).sort(),['kilo','zen','official','modelsdev','pi','ovh','ovhmeta'].sort(),'Invalid legacy source inventory');
  const legacyFresh=Object.values(raw.sources).filter(source=>source.fresh===true).length;
  assert.ok(legacyFresh>0,'An all-failed legacy run cannot seed migration');
  assert.equal(raw.quality.freshSources,legacyFresh);assert.equal(raw.quality.retainedSources,7-legacyFresh);
  assert.equal(raw.quality.status,legacyFresh===7?'fresh':'degraded');
  for(const source of Object.values(raw.sources)){
    exact(source,['url','fresh','status','fetchedAt','attemptedAt','data','dataSha256','bodySha256','rowCount','failure','consecutiveFailures','firstFailureAt'],'source');
    assert.equal(typeof source.fresh,'boolean');assert.equal(source.status,source.fresh?'fresh':'retained');
    assert.equal(source.dataSha256,dataHash(source.data),'Legacy source integrity mismatch');
    assert.match(source.bodySha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(source.rowCount)&&source.rowCount>0&&source.rowCount<=10000);
    assert.ok(timestamp(source.fetchedAt)<=timestamp(raw.generatedAt));assert.equal(source.attemptedAt,raw.generatedAt);
    assert.ok(Number.isSafeInteger(source.consecutiveFailures)&&source.consecutiveFailures>=0);
    if(source.fresh){assert.equal(source.fetchedAt,raw.generatedAt);assert.equal(source.consecutiveFailures,0);assert.equal(source.failure,null);assert.equal(source.firstFailureAt,null);}
    else{assert.ok(source.consecutiveFailures>0);assert.ok(timestamp(source.firstFailureAt)>=timestamp(source.fetchedAt)&&timestamp(source.firstFailureAt)<=timestamp(raw.generatedAt));exact(source.failure,['code','httpStatus'],'failure');assert.ok(['network','timeout','http','size','json','source'].includes(source.failure.code));assert.ok(source.failure.httpStatus===null||(Number.isInteger(source.failure.httpStatus)&&source.failure.httpStatus>=100&&source.failure.httpStatus<=599));}
  }
  assert.ok(Array.isArray(raw.quality?.largeChanges)&&typeof raw.quality.largeChangesApproved==='boolean');
  assert.ok(!raw.quality.largeChanges.length||raw.quality.largeChangesApproved,'Unapproved legacy decline');
  const state=validateState(migrateCatalogState({schemaVersion:1,refreshedAt:raw.generatedAt,sources:raw.sources,...raw.catalog}));
  const nextSummary=summary(state);
  for(const name of ['kilo','ovh'])assert.equal(canonical(raw.summary[name]),canonical(nextSummary[name]),'Legacy summary mismatch');
  const fresh=Object.values(state.sources).filter(s=>s.fresh).length;
  const snapshot=seal({...raw,schemaVersion:2,rulesHash:expectedRules,sources:state.sources,
    catalog:{entries:state.entries,changes:state.changes,history:state.history},summary:nextSummary,
    quality:{...raw.quality,status:fresh===SOURCE_NAMES.length?'fresh':'degraded',freshSources:fresh,retainedSources:SOURCE_NAMES.length-fresh,
      largeChanges:raw.quality.largeChanges.filter(c=>c.kind==='source-rows'?SOURCE_NAMES.includes(c.name):['kilo','ovh'].includes(c.name))}});
  // Full destination validation includes exact URLs, source/data hashes, timestamps,
  // canonicality, provenance, summaries and the Kilo/OVH reconciliation fixed point.
  return validateSnapshot(snapshot,{expectedRules,now});
}
