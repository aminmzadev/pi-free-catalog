// Offline snapshot builder. It is shipped with package tests and never imports repository-only CI code.
import { SOURCES, reconcile, summary } from '../src/catalog.js';
import { seal, rulesHash, project, dataHash, sha256, rowCount, REPOSITORY, asState } from '../src/snapshot-contract.js';
import { fixtures } from './helpers.mjs';
export async function snapshotFixture({data=fixtures,at='2026-10-22T00:00:00.000Z',retained=[],previous=null}={}){
 const sources=Object.fromEntries(Object.keys(SOURCES).map(name=>{
  const payload=project(name,data[name]),fresh=!retained.includes(name);
  return [name,{url:SOURCES[name],fresh,status:fresh?'fresh':'retained',fetchedAt:fresh?at:new Date(Date.parse(at)-900000).toISOString(),attemptedAt:at,data:payload,dataSha256:dataHash(payload),bodySha256:sha256(JSON.stringify(data[name])),rowCount:rowCount(name,payload),failure:fresh?null:{code:'http',httpStatus:503},consecutiveFailures:fresh?0:1,firstFailureAt:fresh?null:at}];
 }));
 const state=reconcile(sources,previous?asState(previous):{},at);
 return seal({schemaVersion:2,generatedAt:at,producer:{repository:REPOSITORY,workflow:'catalog.yml',commit:'a'.repeat(40),runId:'42'},rulesHash:await rulesHash(),sources,catalog:{entries:state.entries,changes:state.changes,history:state.history},summary:summary(state),quality:{status:retained.length?'degraded':'fresh',freshSources:3-retained.length,retainedSources:retained.length,largeChanges:[],largeChangesApproved:false}});
}
export function isPages(url){const u=new URL(String(url));return u.origin+u.pathname==='https://aminmzadev.github.io/pi-free-catalog/catalog/v2/latest.json';}
export function pagesFetcher(snapshot,{fallback,trace=[]}={}){
 return async(url,init)=>{
  trace.push(String(url));
  if(isPages(url))return Response.json(snapshot);
  if(fallback)return fallback(url,init);
  throw Error('Unexpected direct-source or inference request in Pages-only test');
 };
}
