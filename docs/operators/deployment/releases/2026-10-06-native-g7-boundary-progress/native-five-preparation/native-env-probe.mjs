import { spawnSync } from 'node:child_process';
const commands=['initdb.exe','pg_ctl.exe','psql.exe','docker.exe','podman.exe'];
const probe=commands.map(name=>{const r=spawnSync('C:/Windows/System32/where.exe',[name],{windowsHide:true});return{name,actualExit:r.status,signal:r.signal,stdout:r.stdout?.toString('utf8'),stderr:r.stderr?.toString('utf8'),error:r.error?String(r.error):null};});
process.stdout.write(JSON.stringify({at:new Date().toISOString(),platform:process.platform,nativeBinConfigured:typeof process.env.GATEWAY_NATIVE_PG_BIN==='string'&&process.env.GATEWAY_NATIVE_PG_BIN.length>0,probe,postgresExecuted:false})+'\n');
