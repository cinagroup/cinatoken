import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const t='C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4';
const [name,key,...args]=process.argv.slice(2);
if(!/^[a-z0-9-]+$/.test(name??''))throw new Error('Invalid command record name');
const commands={git:['C:/Program Files/Git/cmd/git.exe'],gh:['C:/Program Files/GitHub CLI/gh.exe'],node:['C:/Program Files/nodejs/node.exe'],npm:['C:/Program Files/nodejs/node.exe','C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js']};
if(!commands[key])throw new Error('Unknown executable');
const stdout=t+'/'+name+'.stdout.log',stderr=t+'/'+name+'.stderr.log',resultPath=t+'/'+name+'.result.json';
const out=fs.openSync(stdout,'wx'),err=fs.openSync(stderr,'wx'),at=new Date().toISOString();
const [executable,...prefix]=commands[key];
const child=spawn(executable,[...prefix,...args],{cwd:'C:/cinagroup/cinatoken',windowsHide:true,env:{...process.env,WRANGLER_LOG_PATH:t+'/'+name+'.wrangler.log',WRANGLER_SEND_METRICS:'false'},stdio:['ignore',out,err]});
const result=await new Promise(resolve=>{child.once('error',error=>resolve({actualExit:1,errorCode:error.code??'spawn_error'}));child.once('close',(code,signal)=>resolve({actualExit:code??1,signal}));});
fs.closeSync(out);fs.closeSync(err);
const record={at,finishedAt:new Date().toISOString(),executable,args:[...prefix,...args],cwd:'C:/cinagroup/cinatoken',...result,stdout,stderr};
fs.writeFileSync(resultPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
const lines=fs.readFileSync(stdout,'utf8').split(/\r?\n/);console.log(JSON.stringify({...record,resultPath,stdoutLastLines:lines.slice(-28),stderrLastLines:fs.readFileSync(stderr,'utf8').split(/\r?\n/).slice(-15)}));process.exitCode=result.actualExit;

