import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

function linkTargets(markdown) {
 const inline=[...markdown.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(m=>m[1]);
 const references=[...markdown.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map(m=>m[1]);
 const html=[...markdown.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(m=>m[1]);
 return [...inline,...references,...html];
}
function isPortablePublicLink(target) {
 if(!/^https?:\/\//i.test(target))return false;
 const url=new URL(target);
 // Do not reintroduce a README download/self-link, even through a CDN.
 return !/(?:^|\/)readme(?:[-_.][^/]*)?$/i.test(decodeURIComponent(url.pathname));
}
test('public README has no relative documentation links, README-file links or local HTML resources',async()=>{
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
 for(const target of linkTargets(readme))assert.ok(isPortablePublicLink(target),`Non-portable public README link: ${target}`);
 assert.ok(!readme.includes('README-fa.md'));
});
test('public README guard detects inline, reference and HTML link regressions',()=>{
 const sample='[Guide](PUBLISHING-fa.md)\n[English](./README.md)\n[doc]: ../README.md\n<a href="README-fa.md">FA</a>\n<img src="./preview.png">\n[CDN](https://cdn.example.com/README.md)';
 const targets=linkTargets(sample);assert.equal(targets.length,6);
 assert.ok(targets.every(t=>!isPortablePublicLink(t)));
 assert.equal(isPortablePublicLink('https://pi.dev/docs/latest/packages'),true);
});
test('README installation examples match the package name and any pinned version matches the manifest',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
 assert.ok(readme.includes(`pi install npm:${pkg.name}`));
 for(const match of readme.matchAll(/pi install npm:([a-z0-9-]+)@([^\s`]+)/g)){
  assert.equal(match[1],pkg.name);
  assert.equal(match[2],pkg.version);
 }
 assert.doesNotMatch(readme,/unreleased candidate|0\.1\.3 candidate|pi install npm:pi-free-catalog@0\.1\.2/i);
});
