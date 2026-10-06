import fs from 'node:fs';import path from 'node:path';import{fileURLToPath}from'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));let s=fs.readFileSync(path.join(out,'prepare-data-reader.mjs'),'utf8');
s=s.replace('for(const f of copied)fs.copyFileSync(path.join(old,f),path.join(out,f),fs.constants.COPYFILE_EXCL);','for(const f of copied){const source=path.join(old,f),target=path.join(out,f);if(fs.existsSync(target))assert.deepEqual(fs.readFileSync(target),fs.readFileSync(source));else fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}');
s=s.replace('const rows=final.records??final.nativeRecords??final.originalNativeRecords;','const rows=final.chain55to113.records;');
fs.writeFileSync(path.join(out,'prepare-data-reader-v3.mjs'),s,{flag:'wx'});
