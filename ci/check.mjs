import { readdir } from 'node:fs/promises';
import { run } from './lib.mjs';
async function check(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path=directory+'/'+entry.name;
    if(entry.isDirectory()) await check(path);
    else if(entry.name.endsWith('.mjs')) run(process.execPath,['--check',path]);
  }
}
await check('ci');
console.log('Repository-only automation syntax: PASS');
