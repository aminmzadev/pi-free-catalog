import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)),
  files = ['index.js'];
for (const dir of ['src', 'scripts', 'test'])
  for (const file of await readdir(new URL(`../${dir}/`, import.meta.url))) {
    if (/\.(mjs|js)$/.test(file)) files.push(`${dir}/${file}`);
  }
for (const file of files) {
  const p = spawnSync(process.execPath, ['--check', `${root}${file}`], {
    encoding: 'utf8',
  });
  if (p.status !== 0) {
    console.error(p.stderr);
    process.exit(1);
  }
}
for (const file of await readdir(new URL('../scripts/', import.meta.url))) {
  if (!file.endsWith('.py')) continue;
  const p = spawnSync(
    'python3',
    [
      '-c',
      'import ast,pathlib,sys;ast.parse(pathlib.Path(sys.argv[1]).read_text())',
      `${root}scripts/${file}`,
    ],
    { encoding: 'utf8' },
  );
  if (p.status !== 0) {
    console.error(p.stderr || p.error);
    process.exit(1);
  }
}
console.log('JavaScript and Python syntax checks passed');
