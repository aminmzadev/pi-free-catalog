import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { json, checkArtifact, run, sha256 } from './lib.mjs';
const pkg = await json('package.json'), directory = resolve('artifacts/release');
const { file, receipt } = await checkArtifact(directory, pkg, { commit: run('git',['rev-parse','HEAD']).trim() });
const temp = await mkdtemp(join(tmpdir(),'pi-installed-ci-'));
try {
  const home = join(temp,'home'), agent = join(temp,'agent'); await mkdir(home); await mkdir(agent);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, NPM_CONFIG_USERCONFIG: join(temp,'empty-npmrc'), NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_UPDATE_NOTIFIER: 'false', PI_SKIP_VERSION_CHECK: '1' };
  for (const key of ['NODE_AUTH_TOKEN','NPM_TOKEN','GH_TOKEN','GITHUB_TOKEN']) delete env[key];
  await writeFile(join(temp,'package.json'), JSON.stringify({ name:'pi-installed-artifact-ci',private:true,type:'module' }));
  const hosts = Object.entries(pkg.devDependencies).filter(([name]) => name.startsWith('@earendil-works/pi-')).map(([name,version]) => `${name}@${version}`);
  assert.equal(hosts.length,3);
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund','--save-exact',file,...hosts],{ cwd:temp, env, inherit:true });
  const installed = join(temp,'node_modules',pkg.name);
  await assert.rejects(lstat(join(installed,'node_modules')));
  // Compare all installed files against npm's manifest using an independent tar reader.
  run('python3',['-c',`import tarfile,pathlib,sys\np=pathlib.Path(sys.argv[2])\nwith tarfile.open(sys.argv[1]) as t:\n for m in t.getmembers():\n  assert m.isfile() and m.name.startswith('package/') and '..' not in pathlib.PurePosixPath(m.name).parts\n  assert (p/m.name.removeprefix('package/')).read_bytes()==t.extractfile(m).read(),m.name\n`,file,installed],{cwd:temp,env});
  const smoke = join(temp,'loader-smoke.mjs'); await copyFile(new URL('./loader-smoke.mjs',import.meta.url),smoke);
  run(process.execPath,[smoke,installed],{cwd:temp,env,inherit:true});
  // All shipped tests and real SDK/session regressions run from the actual installed directory.
  run('npm',['run','verify'],{cwd:installed,env,inherit:true});
  const { bytes } = await checkArtifact(directory,pkg); assert.equal(sha256(bytes),receipt.sha256);
  console.log('Installed TGZ verification: PASS; exact bytes preserved; no production factory replacement.');
} finally { await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
