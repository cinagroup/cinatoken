import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7';
const info=b=>({bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});
const entries=fs.readdirSync(root,{withFileTypes:true}).map(d=>({name:d.name,file:d.isFile(),directory:d.isDirectory(),...(d.isFile()?info(fs.readFileSync(path.join(root,d.name))):{})}));
console.log(JSON.stringify({root,entries},null,2));
for(const d of entries.filter(x=>x.file&&/FINAL|seal|manifest/.test(x.name)&&x.name.endsWith('.json'))){const r=JSON.parse(fs.readFileSync(path.join(root,d.name),'utf8'));console.log(d.name,JSON.stringify(r,null,2));}