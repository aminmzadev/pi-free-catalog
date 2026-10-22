import { readdir } from 'node:fs/promises';
import { run } from './lib.mjs';
for (const directory of ['ci','ci/test']) for (const file of await readdir(directory)) if (file.endsWith('.mjs')) run(process.execPath,['--check',`${directory}/${file}`]);
console.log('Repository-only automation syntax: PASS');
