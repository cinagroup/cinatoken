import {readFileSync,readdirSync,lstatSync} from 'node:fs';import {join} from 'node:path';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504';const art=join(root,'g7-artifact-current');const names=readdirSync(art);
const special=names.filter(n=>n.endsWith('.json')&&!/^(?:fallback-)?\d{3}-/.test(n));
function short(x){if(Array.isArray(x))return {arrayLength:x.length,first:x.slice(0,2)};if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,Array.isArray(v)?{arrayLength:v.length,first:v.slice(0,1)}:v]));return x;}
console.log(JSON.stringify({topEntries:names.length,special},null,2));
for(const name of special){let val=JSON.parse(readFileSync(join(art,name),'utf8'));console.log(JSON.stringify({file:name,bytes:lstatSync(join(art,name)).size,keys:Object.keys(val),value:short(val)},null,2));}
for(const name of ['001-git.result.json','083-docker.result.json','fallback-029-docker.result.json'])if(names.includes(name))console.log(JSON.stringify({file:name,value:JSON.parse(readFileSync(join(art,name),'utf8'))},null,2));
const jobs=JSON.parse(readFileSync(join(root,'proxy-progress-2.raw.stdout.log'),'utf8'));console.log(JSON.stringify({proxyRun:jobs.databaseId,head:jobs.headSha,status:jobs.status,conclusion:jobs.conclusion,jobs:jobs.jobs.map(j=>({id:j.databaseId,name:j.name,conclusion:j.conclusion,steps:j.steps.filter(s=>s.number>=53&&s.number<=61||s.number===27)}))},null,2));
