import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import installedPostgres from 'postgres';
import { ownPostgresRecoveryOperations } from './postgres-recovery-operation-owner.ts';

const override=process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER;
if(override&&!isAbsolute(override))throw new Error('Driver override must be an absolute local path');
const postgres=override?(await import(pathToFileURL(override).href)).default:installedPostgres;
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function frame(kind,payload){const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload),out=Buffer.alloc(data.length+5);out[0]=kind.charCodeAt(0);out.writeUInt32BE(data.length+4,1);data.copy(out,5);return out;}

// Bounded, no-auth/TLS loopback protocol probe; no SQL is evaluated and no real backend PID
// or cancellation secret is used. A cancel connection intentionally cannot affect the main one.
async function fixture(t){
  const sockets=new Set(),cancelled=deferred(),entered=deferred(),trace=[];let primary,failure,cancels=0;
  const backend=Buffer.alloc(8);backend.writeUInt32BE(1234);backend.writeUInt32BE(5678,4);
  const server=createServer(socket=>{
    sockets.add(socket);assert.ok(sockets.size<=2);let startup=true,buffer=Buffer.alloc(0);
    socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.on('data',data=>{try{
      buffer=Buffer.concat([buffer,data]);assert.ok(buffer.length<32768);
      while(buffer.length>=(startup?4:5)){
        const length=buffer.readUInt32BE(startup?0:1)+(startup?0:1);assert.ok(length>=5&&length<32768);if(buffer.length<length)return;
        const packet=buffer.subarray(0,length);buffer=buffer.subarray(length);
        if(startup){
          const code=packet.readUInt32BE(4);
          if(code===80877102){assert.equal(packet.length,16);assert.equal(packet.readUInt32BE(8),1234);assert.equal(packet.readUInt32BE(12),5678);
            cancels++;assert.equal(cancels,1);socket.end();socket.once('close',()=>cancelled.resolve());return;}
          assert.equal(code,196608);startup=false;primary=socket;
          socket.write(Buffer.concat([frame('R',Buffer.alloc(4)),frame('K',backend),frame('Z','I')]));
        }else if(packet[0]===81){const sql=packet.subarray(5,-1).toString();assert.equal(sql,'select cancellation_probe');trace.push(sql);assert.equal(trace.length,1);
          socket.write(frame('C','SELECT 0\0'));entered.resolve();}
        else if(packet[0]===88)socket.end();else throw new Error('Unexpected frame '+packet[0]);
      }
    }catch(error){failure??=error;socket.destroy();}});
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const raw=postgres({host:'127.0.0.1',port:server.address().port,database:'synthetic',username:'synthetic',password:'synthetic',
    ssl:false,fetch_types:false,prepare:false,max:1,connect_timeout:1,backoff:0});
  t.after(async()=>{try{await raw.end({timeout:0});}finally{for(const socket of sockets)socket.destroy();await new Promise(yes=>server.close(yes));}assert.ifError(failure);});
  return {raw,entered:entered.promise,cancelled:cancelled.promise,trace,cancels:()=>cancels,release:()=>primary.write(frame('Z','I'))};
}

test('public Query.cancel discards the cancellation promise and main query can still succeed',{timeout:5000},async t=>{
  const f=await fixture(t),q=f.raw.unsafe('select cancellation_probe');let done=false;
  const completion=Promise.resolve(q).then(value=>{done=true;return value;});await f.entered;
  assert.equal(q.cancel(),null);await f.cancelled;await tick();assert.equal(done,false);assert.equal(q.cancel(),null);assert.equal(f.cancels(),1);
  f.release();assert.equal((await completion).length,0);assert.equal(f.trace.length,1);
});
test('even internal cancel-transport completion is not main-query ReadyForQuery or an owner release receipt',{timeout:5000},async t=>{
  const f=await fixture(t);let query;
  const raw={options:f.raw.options,unsafe(sql,params){query=f.raw.unsafe(sql,params);return query;}};
  const owner=ownPostgresRecoveryOperations({driver:'postgres',raw},()=>{});
  const completion=Promise.resolve(owner.client.raw.unsafe('select cancellation_probe'));await f.entered;
  // Internal hook used only to inspect the discarded transport Promise. NOT a supported
  // application cancellation API; production recovery must not depend on this field.
  const transport=query.canceller(query);assert.equal(typeof transport.then,'function');await transport;await f.cancelled;
  assert.equal(owner.pending(),1);assert.equal(owner.snapshot().statement,1);
  let drained=false;const drain=owner.drain().then(value=>{drained=true;return value;});await tick();assert.equal(drained,false);
  f.release();await completion;assert.equal(await drain,'confirmed');assert.equal(f.trace.length,1);
});
