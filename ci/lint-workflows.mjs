import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, sha256 } from './lib.mjs';
const version='1.7.12', checksum='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
// Never leave binary tools in the source tree (the existing English-only scanner is strict).
const directory=await mkdtemp(join(tmpdir(),'pi-actionlint-'));
try {
  const archive=join(directory,'actionlint.tar.gz'), executable=join(directory,'actionlint');
  run('curl',['--fail','--silent','--show-error','--location','--max-time','60','--max-filesize','20000000','--retry','2',`https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz`,'--output',archive]);
  assert.equal(sha256(await readFile(archive)),checksum,'Actionlint archive checksum mismatch');
  run('tar',['-xzf',archive,'-C',directory,'actionlint']);
  assert.match(run(executable,['--version']),new RegExp('^'+version.replaceAll('.','\\.')));
  run(executable,['-color','.github/workflows/ci.yml','.github/workflows/publish.yml'],{inherit:true});
  console.log('Pinned actionlint workflow validation: PASS');
} finally { await rm(directory,{recursive:true,force:true}); }
