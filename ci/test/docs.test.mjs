// Repository-only documentation checks. No live HTTP and no image libraries required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const load = file => readFile(join(root, file), 'utf8');

test('Python README illustration regenerates exactly in read-only check mode', async () => {
  const file = join(root, 'docs/assets/catalog-overview.svg');
  const before = await readFile(file);
  const result = spawnSync('python3', ['ci/docs/render-overview.py', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Illustration reproducibility: PASS/);
  assert.deepEqual(await readFile(file), before);
});

test('README SVG is accessible, bounded and has no executable or external resources', async () => {
  const result = spawnSync('python3', ['-c', `import xml.etree.ElementTree as E,pathlib\np=pathlib.Path('docs/assets/catalog-overview.svg');b=p.read_bytes();assert len(b)<128000\nr=E.fromstring(b);ns='{http://www.w3.org/2000/svg}';ids={e.attrib['id'] for e in r.iter() if 'id' in e.attrib}\nassert r.tag==ns+'svg' and r.attrib['viewBox']=='0 0 1600 1000'\nassert r.attrib['role']=='img' and r.find(ns+'title') is not None and r.find(ns+'desc') is not None\nfor e in r.iter():\n assert e.tag.rsplit('}',1)[-1] not in ['script','foreignObject','image','iframe','style']\n for k,v in e.attrib.items():\n  assert not k.lower().startswith('on')\n  if k.rsplit('}',1)[-1] in ['href','src']: assert v.startswith('#') and v[1:] in ids\n  assert 'https:' not in v and 'http:' not in v\n`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('README badges use actual CI/catalog and npm endpoints, not invented uptime or model totals', async () => {
  const md = await load('README.md');
  assert.ok(md.includes('https://github.com/aminmzadev/pi-free-catalog/actions/workflows/ci.yml/badge.svg?branch=main'));
  assert.ok(md.includes('https://github.com/aminmzadev/pi-free-catalog/actions/workflows/catalog.yml/badge.svg?branch=main'));
  assert.ok(md.includes('https://img.shields.io/npm/v/pi-free-catalog'));
  assert.doesNotMatch(md, /shields\.io\/badge\/(?:uptime|models|tests|coverage)-/i);
  assert.match(md, /pi install npm:pi-free-catalog/);
});

test('public README image and repository document URLs resolve to actual source paths', async () => {
  const md = await load('README.md');
  const targets = [...md.matchAll(/!?\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]);
  const raw = 'https://raw.githubusercontent.com/aminmzadev/pi-free-catalog/main/';
  const docs = 'https://github.com/aminmzadev/pi-free-catalog/blob/main/';
  let assets = 0;
  for (const target of targets) {
    const prefix = target.startsWith(raw) ? raw : target.startsWith(docs) ? docs : null;
    if (!prefix) continue;
    const path = decodeURIComponent(target.substring(prefix.length).split(/[?#]/)[0]);
    assert.ok(path && !path.split('/').includes('..'));
    await access(join(root, path));
    if (path === 'docs/assets/catalog-overview.svg') assets++;
  }
  assert.equal(assets, 1);
});

test('README keeps approved free-model scope, typography and operational safety', async () => {
  const md = await load('README.md');
  assert.match(md, /Only models with free-access evidence are eligible/);
  assert.match(md, /No personal provider API key or paid fallback/);
  assert.match(md, /not a 15-minute freshness SLA/);
  assert.match(md, /New pools start \*\*OFF\*\*/);
  assert.match(md, /Completed tool effects are never replayed/);
  assert.match(md, /review that consent before enabling it/);
  assert.doesNotMatch(md, /\u2014/);
  assert.doesNotMatch(md, /pi install npm:pi-free-catalog@0\.1\.7/);
  const outlines = JSON.parse(await load('ci/docs/fonts/outlines.json'));
  assert.deepEqual(Object.keys(outlines), ['450', '600', '700']);
  assert.match(await load('ci/docs/fonts/OFL.txt'), /SIL OPEN FONT LICENSE/);
});

test('release documentation has no operation-specific status or detached note drafts', async () => {
  const docs = await readdir(join(root, 'docs'));
  assert.ok(!docs.some(name => /^RELEASE-NOTES-/.test(name)));
  const changelog = await load('CHANGELOG.md');
  assert.match(changelog, /^## 0\.1\.7$/m);
  assert.doesNotMatch(changelog, /Prepared for the next separately approved release|release-documentation preparation/);
  for (const path of ['README.md', 'REFERENCE.md', 'CHANGELOG.md', 'CATALOG-BACKEND.md']) {
    const text = await load(path);
    assert.doesNotMatch(text, /October 23, 2026|Known Zen limitation|Zen requests returned HTTP 403|RELEASE-NOTES-0\.1\.7/);
  }
});
