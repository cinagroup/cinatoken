import fs from 'node:fs';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7';
for(const f of ['run-command.mjs','finalize-capsule.mjs'])console.log(f+'\n'+fs.readFileSync(root+'/'+f,'utf8'));