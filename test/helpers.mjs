import { mock } from 'node:test';
// Snapshot-specific assertions must not change when factual deadlines pass in real time.
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T00:00:00Z') });
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SOURCES, reconcile } from '../src/catalog.js';
export const fixtures=Object.fromEntries(Object.keys(SOURCES).map(name=>[name,JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${({kilo:'kilo',zen:'opencode',official:'opencode-capabilities',modelsdev:'models-dev',pi:'pi-opencode-catalog',ovh:'ovh-models',ovhmeta:'ovh-catalog'})[name]}.json.gz`,import.meta.url))))]));
export function sources(data=fixtures) {return Object.fromEntries(Object.entries(data).map(([k,v])=>[k,{url:SOURCES[k],fresh:true,fetchedAt:k.startsWith('ovh')?'2026-10-22T00:00:00Z':'2026-10-17T04:28:58Z',data:structuredClone(v)}]));}
export const state=()=>reconcile(sources());
export function fetcher(data=fixtures,fail=[]) {return async(url)=>{const parsed=new URL(String(url));if(parsed.origin+parsed.pathname==='https://aminmzadev.github.io/pi-free-catalog/catalog/v1/latest.json'){if([...parsed.searchParams.keys()].join(',')!=='catalog_read')throw new Error('Unexpected Pages query');return new Response(null,{status:503});}const name=Object.keys(SOURCES).find(k=>SOURCES[k]===String(url));if(!name)throw new Error('Unexpected URL '+url);if(fail.includes(name))throw new Error('Simulated network failure');return Response.json(data[name]);};}
