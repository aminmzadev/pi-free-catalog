import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

// Explicit Unicode ranges keep the rule readable without embedding the script it rejects.
const prohibited=/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u;
function checkText(text,label){
 assert.ok(!prohibited.test(text),`Non-English release text in ${label}`);
 // Catch escaped JSON/code strings as well as literal characters.
 const unescaped=text.replace(/\\u([0-9a-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
 // The test's regex declaration is policy, not a string containing release text.
 if(!label.endsWith('english-only.test.mjs'))assert.ok(!prohibited.test(unescaped),`Escaped non-English text in ${label}`);
}
test('release source, documentation and decompressed catalog fixtures contain no Persian/Arabic-script text',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));let checked=0;
 async function walk(dir){
  for(const item of await readdir(dir,{withFileTypes:true})){
   if(['node_modules','.git','artifacts','verification'].includes(item.name))continue;
   const p=join(dir,item.name);
   if(item.isDirectory()){await walk(p);continue;}
   if(!item.isFile())continue;
   let data=await readFile(p);if(item.name.endsWith('.gz'))data=gunzipSync(data);
   checkText(data.toString('utf8'),p);checked++;
  }
 }
 await walk(root);assert.ok(checked>=30);
});
test('English-only guard rejects literal and escaped script characters without dropping Unicode coverage',()=>{
 assert.throws(()=>checkText(String.fromCharCode(0x0633),'sample.txt')); 
 assert.throws(()=>checkText('\\u0633','sample.json')); 
 assert.doesNotThrow(()=>checkText('Hello 🧠 — model-🧪-1','sample.txt'));
});
