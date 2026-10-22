import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, checkReleaseGit, checkMetadata, assertUnpublished, checkPublishedBytes, checkArtifact, registryJson, boundedBody, tarballUrl, sha256, sha1, integrity, STABLE_TAG, REPOSITORY, REGISTRY } from '../lib.mjs';
const pkg = JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
const lock = JSON.parse(await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'));
const commit='a'.repeat(40), context=()=>({eventName:'release',repository:REPOSITORY,ref:'refs/tags/v'+pkg.version,sha:commit,event:{action:'published',release:{tag_name:'v'+pkg.version,draft:false,prerelease:false}}});
const receiptFor = bytes => ({name:pkg.name,version:pkg.version,filename:`${pkg.name}-${pkg.version}.tgz`,bytes:bytes.length,sha256:sha256(bytes),integrity:integrity(bytes),commit});
const versionFor = (receipt,bytes) => ({name:receipt.name,version:receipt.version,dist:{tarball:`${REGISTRY}/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,integrity:receipt.integrity,shasum:sha1(bytes)}});

test('stable non-draft release from exact repository and matching package/lock/ref is accepted',()=>{const r=checkRelease(context(),pkg,lock);assert.equal(r.commit,commit);assert.equal(r.version,pkg.version);});
for (const [label,change] of [
 ['fork',c=>c.repository='someone/else'],['push',c=>c.eventName='push'],['manual dispatch',c=>c.eventName='workflow_dispatch'],['release edited',c=>c.event.action='edited'],['draft',c=>c.event.release.draft=true],['prerelease',c=>c.event.release.prerelease=true],['missing draft flag',c=>delete c.event.release.draft],['wrong ref',c=>c.ref='refs/heads/main'],['wrong tag version',c=>c.event.release.tag_name='v999.0.0'],['invalid sha',c=>c.sha='main'],['missing event',c=>delete c.event],
]) test('rejects '+label,()=>{const c=context();change(c);assert.throws(()=>checkRelease(c,pkg,lock));});
for (const tag of ['1.2.3','v01.2.3','v1.02.3','v1.2.03','v1.2.3-beta.1','v1.2.3+build','v1.2.3\n','v1.2','v-1.2.3','v1.2.3/../../main']) test('rejects unstable/malformed tag '+JSON.stringify(tag),()=>assert.ok(!STABLE_TAG.test(tag)));
for (const label of ['name','repository','registry','access','lock-root','lock-package']) test('rejects metadata mismatch '+label,()=>{
 const p=structuredClone(pkg),l=structuredClone(lock);
 if(label==='name')p.name='another-package';if(label==='repository')p.repository.url='git+https://github.com/fork/else.git';if(label==='registry')p.publishConfig.registry='https://evil.invalid/';if(label==='access')p.publishConfig.access='restricted';if(label==='lock-root')l.version='9.9.9';if(label==='lock-package')l.packages[''].version='9.9.9';assert.throws(()=>checkMetadata(p,l));
});
test('git guards accept only matching HEAD/tag and successful ancestry check',()=>{const seen=[];checkReleaseGit({commit,tag:'v1.2.3'},args=>{seen.push(args);return args[0]==='rev-parse'?commit:'';});assert.deepEqual(seen.at(-1),['merge-base','--is-ancestor',commit,'refs/remotes/origin/main']);});
for(const reason of ['checkout','tag','main'])test('git guards reject '+reason,()=>assert.throws(()=>checkReleaseGit({commit,tag:'v1.2.3'},args=>{if(reason==='main'&&args[0]==='merge-base')throw Error('not ancestor');if(args[0]==='rev-parse')return (reason==='checkout'&&args[1]==='HEAD')||(reason==='tag'&&args[1]!=='HEAD')?'b'.repeat(40):commit;return '';})));
const history=()=>({name:pkg.name,versions:{'0.0.1':{version:'0.0.1'}}});
test('unpublished version needs both explicit 404 and healthy existing package history',async()=>{const calls=[];await assertUnpublished('99.0.0',{fetch:async url=>{calls.push(url);return url.endsWith('/99.0.0')?new Response(null,{status:404}):Response.json(history());}});assert.equal(calls.length,2);});
for (const status of [200,401,403,429,500,503])test('preflight fails closed for version endpoint HTTP '+status,async()=>assert.rejects(assertUnpublished('99.0.0',{fetch:async()=>Response.json({version:'99.0.0'},{status})})));
for(const condition of ['network','invalid json','empty history','history already contains version','wrong package','history 404','oversized'])test('preflight fails closed on '+condition,async()=>{
 await assert.rejects(assertUnpublished('99.0.0',{fetch:async url=>{
  if(condition==='network')throw Error('offline');if(url.endsWith('/99.0.0'))return new Response(null,{status:404});
  if(condition==='invalid json')return new Response('{');if(condition==='empty history')return Response.json({name:pkg.name,versions:{}});if(condition==='wrong package')return Response.json({...history(),name:'other'});if(condition==='history 404')return new Response(null,{status:404});if(condition==='oversized')return new Response('x'.repeat(2*1024*1024+1));return Response.json({name:pkg.name,versions:{'99.0.0':{}}});
 }}));
});
test('registry reader does not follow redirects or send authentication headers',async()=>{
 await registryJson(REGISTRY+'/'+pkg.name,{fetch:async(url,init)=>{assert.equal(init.redirect,'error');assert.ok(init.signal);assert.deepEqual(Object.keys(init.headers).sort(),['accept','cache-control']);return Response.json(history());}});
 await assert.rejects(registryJson('https://evil.invalid/package'));await assert.rejects(registryJson('https://user:secret@registry.npmjs.org/package'));
});
test('bounded body refuses oversized responses',async()=>await assert.rejects(boundedBody(new Response('12345'),4)));
test('registry verification accepts exact bytes, SHA256/SHA512/SHA1 and latest',()=>{const bytes=Buffer.from('actual tarball'),r=receiptFor(bytes);checkPublishedBytes(r,versionFor(r,bytes),{latest:pkg.version},bytes);});
for(const condition of ['name','version','latest','bytes','size','sha256','integrity','shasum','url'])test('registry verification rejects mismatched '+condition,()=>{
 let bytes=Buffer.from('actual tarball'),r=receiptFor(bytes),v=versionFor(r,bytes),tags={latest:pkg.version};
 if(condition==='name')v.name='other';if(condition==='version')v.version='99.0.0';if(condition==='latest')tags.latest='0.0.0';if(condition==='bytes')bytes=Buffer.from('tampered blob');if(condition==='size')r.bytes++;if(condition==='sha256')r.sha256='0'.repeat(64);if(condition==='integrity')v.dist.integrity='sha512-fake';if(condition==='shasum')v.dist.shasum='0'.repeat(40);if(condition==='url')v.dist.tarball='https://evil.invalid/file.tgz';assert.throws(()=>checkPublishedBytes(r,v,tags,bytes));
});
for(const url of ['http://registry.npmjs.org/pi-free-catalog/-/x.tgz','https://registry.npmjs.org.evil.invalid/file.tgz','https://registry.npmjs.org/pi-free-catalog/-/wrong.tgz','https://registry.npmjs.org/pi-free-catalog/-/pi-free-catalog-'+pkg.version+'.tgz?other=1'])test('rejects redirected/unexpected artifact URL '+url,()=>assert.throws(()=>tarballUrl({tarball:url},pkg.version)));
for(const condition of ['valid','tampered bytes','wrong expected hash','wrong commit','unsafe filename','symlink'])test('artifact validation: '+condition,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'release-guard-test-'));try{
  const bytes=Buffer.from('archive'),receipt=receiptFor(bytes),file=join(directory,receipt.filename);
  if(condition==='symlink'){await writeFile(join(directory,'actual'),bytes);await symlink(join(directory,'actual'),file);}else await writeFile(file,condition==='tampered bytes'?'tampered':bytes);
  if(condition==='unsafe filename')receipt.filename='../escape.tgz';await writeFile(join(directory,'release.json'),JSON.stringify(receipt));
  const operation=()=>checkArtifact(directory,pkg,{expectedSha256:condition==='wrong expected hash'?'0'.repeat(64):receipt.sha256,commit:condition==='wrong commit'?'b'.repeat(40):commit});
  if(condition==='valid')assert.equal((await operation()).receipt.sha256,receipt.sha256);else await assert.rejects(operation());
 }finally{await rm(directory,{recursive:true,force:true});}
});
