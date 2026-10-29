import assert from 'node:assert/strict';
import { run } from '../lib.mjs';
import { validateSnapshot, rulesHash, sha256, canonical, MAX_SNAPSHOT_BYTES } from './core.mjs';
import { deploymentPath } from './deployment-path.mjs';
const expected = process.env.EXPECTED_SNAPSHOT_SHA256;
assert.match(expected || '', /^[a-f0-9]{64}$/);
const unique = deploymentPath(process.env.GITHUB_RUN_ID, expected);
// Inspect the archive without extracting any files. Both JSON copies must be byte-identical.
const json = run('python3', ['-c', `import tarfile,sys,pathlib
unique=sys.argv[2];limit=int(sys.argv[3])
allowed={'index.html','catalog/v2/latest.json','catalog/v2/schema.json',unique}
dirs={'.','catalog','catalog/v2','catalog/v2/runs',str(pathlib.PurePosixPath(unique).parent)}
with tarfile.open(sys.argv[1]) as t:
 seen={};size=0
 for m in t.getmembers():
  p=pathlib.PurePosixPath(m.name)
  assert not p.is_absolute() and '..' not in p.parts,m.name
  assert m.isdir() or m.isfile(),m.name
  if m.isdir():
   assert str(p) in dirs,m.name
   continue
  n=str(p);assert n in allowed and n not in seen,n
  cap=limit if n.endswith('.json') and n!='catalog/v2/schema.json' else 1048576
  assert 0<=m.size<=cap,n
  seen[n]=m;size+=m.size;assert size<=2*limit+2097152
 assert set(seen)==allowed
 a=t.extractfile(seen['catalog/v2/latest.json']).read(limit+1)
 b=t.extractfile(seen[unique]).read(limit+1)
 assert len(a)<=limit and a==b,'Latest and run-specific snapshots differ'
 sys.stdout.buffer.write(a)
`, 'artifacts/catalog/download/artifact.tar', unique, String(MAX_SNAPSHOT_BYTES)]);
assert.equal(sha256(json), expected, 'Downloaded snapshot differs from validated build output');
const snapshot = validateSnapshot(JSON.parse(json), { expectedRules: await rulesHash() });
assert.equal(sha256(canonical(snapshot) + '\n'), expected, 'Snapshot is not canonical');
assert.equal(snapshot.producer.commit, process.env.GITHUB_SHA);
assert.equal(snapshot.producer.runId, process.env.GITHUB_RUN_ID);
console.log('Exact Pages artifact: identical latest/run-specific bytes, hash, contract and commit/run identity verified.');
