import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import installedPostgres from 'postgres';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownPostgresRecoveryOperationsForDiagnostics } from './postgres-recovery-operation-owner.ts';

const frame=(type,text)=>{const data=Buffer.isBuffer(text)?text:Buffer.from(text),value=Buffer.alloc(5+data.length);
  value[0]=type.charCodeAt(0);value.writeUInt32BE(4+data.length,1);data.copy(value,5);return value;};
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
// Explicit subprocess-only override. Default remains the unmodified installed driver:
// its negative onclose regression must keep failing until dependency adoption is approved.
const candidatePath=process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER;
if(candidatePath&&!isAbsolute(candidatePath))throw new Error('Candidate driver must be an absolute local path');
const postgres=candidatePath?(await import(pathToFileURL(candidatePath).href)).default:installedPostgres;
const factoryInitializesSession=process.env.GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION==='1';
if(factoryInitializesSession&&!candidatePath)throw new Error('Session factory requires explicit candidate module');

/** Loopback protocol fixture only. Executes NO SQL, authentication, TLS or pooler behavior. */
export async function peer(t,{holdReady=false,holdBegin=false,holdFinish=false,maxPipeline=100,beginBackpressure=false,rejectBegin=false,writeFault=null,backendIdentity=false,holdCancelClose=false,holdPrimaryClose=false,rawCloseGate=false,omitPrimaryRawClosed=false,cancelRawCloseGate=false,beforeSocket=null,holdDescribe=false,cancelReply=false}={}){
  const sockets=new Set(),clientSockets=new Set(),queries=[],trace=[],states=[],observers=new Map(),entered=deferred(),release=deferred();let failure,connections=0,forcedFalse=0;
  const cancelPackets=[],cancelled=deferred(),cancelSockets=new Set();let socketCreations=0;
  const described=deferred(),describeRelease=deferred();
  const releaseCancel=()=>{for(const socket of cancelSockets)socket.end();cancelSockets.clear();};
  const server=createServer(socket=>{
    sockets.add(socket);connections++;socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    const connectionId=connections;
    let startup=true,buffer=Buffer.alloc(0),transaction=false,heldSync=false,paused=false,pendingBytes=0;
    const pendingFrames=[];
    const statements=new Map(),statementParameters=new Map(),portals=new Map();
    const stringAt=(packet,start)=>{const end=packet.indexOf(0,start);assert.ok(end>=start);return [packet.subarray(start,end).toString(),end+1];};
    const send=data=>{if(!paused)return socket.write(data);pendingBytes+=data.length;assert.ok(pendingBytes<=65536);pendingFrames.push(data);};
    // Preserve response ordering across a pipelined BEGIN: every frame after the held
    // ReadyForQuery stays behind it. Capture transaction status at frame construction.
    const ready=()=>{if(heldSync){heldSync=false;if(!paused){paused=true;void release.promise.then(()=>{
      paused=false;if(!socket.destroyed&&pendingFrames.length)socket.write(Buffer.concat(pendingFrames));pendingFrames.length=0;pendingBytes=0;
    });}}send(frame('Z',transaction?'T':'I'));};
    function execute(query){
      queries.push(query);trace.push({connectionId,query:query.trim()});assert.ok(queries.length<=20);
      states.push({connectionId,query:query.trim(),transactionBefore:transaction});
      observers.get(query)?.resolve();observers.delete(query);
      const kind=query.trim().split(/\s+/)[0].toUpperCase();assert.ok(['BEGIN','SELECT','COMMIT','ROLLBACK','SAVEPOINT','RELEASE','PREPARE','SET'].includes(kind));
      if(kind==='SET')assert.equal(query,'SET search_path TO cinatoken_gateway, public');
      if(kind==='BEGIN'&&rejectBegin){send(frame('E','SERROR\0C25001\0Msynthetic BEGIN rejected\0\0'));return;}
      if(kind==='BEGIN')transaction=true;else if(kind==='COMMIT'||(kind==='ROLLBACK'&&!/^rollback to\b/i.test(query.trim())))transaction=false;
      send(frame('C',kind==='SELECT'?'SELECT 0\0':kind+'\0'));
      if(kind==='SELECT')entered.resolve();heldSync=(kind==='BEGIN'&&holdBegin)||(['COMMIT','ROLLBACK'].includes(kind)&&holdFinish)||(kind==='SELECT'&&(typeof holdReady==='function'?holdReady(query):holdReady));
    }
    socket.on('data',data=>{
      try{
        assert.ok(connections<=4);buffer=Buffer.concat([buffer,data]);assert.ok(buffer.length<=32768);
        while(buffer.length>=(startup?4:5)){
          const length=buffer.readUInt32BE(startup?0:1)+(startup?0:1);assert.ok(length>=5&&length<=32768);
          if(buffer.length<length)return;const packet=buffer.subarray(0,length);buffer=buffer.subarray(length);
          if(startup){
            if(backendIdentity&&packet.readUInt32BE(4)===80877102){
              assert.equal(packet.length,16);cancelPackets.push({pid:packet.readUInt32BE(8),secret:packet.readUInt32BE(12)});assert.ok(cancelPackets.length<=2);
              cancelled.resolve();if(cancelReply)socket.write(frame('Z','I'));holdCancelClose?cancelSockets.add(socket):socket.end();return;
            }
            assert.equal(packet.readUInt32BE(4),196608);startup=false;
            const key=Buffer.alloc(8);key.writeUInt32BE(1000+connectionId);key.writeUInt32BE(2000+connectionId,4);
            send(Buffer.concat([frame('R',Buffer.alloc(4)),...(backendIdentity?[frame('K',key)]:[]),frame('Z','I')]));
          }
          else if(packet[0]===81){execute(packet.subarray(5,-1).toString());ready();}
          else if(packet[0]===80){const [name,start]=stringAt(packet,5),[query,end]=stringAt(packet,start);const parameters=packet.readUInt16BE(end);assert.ok(parameters<=4);
            statements.set(name,query);statementParameters.set(name,parameters);assert.ok(statements.size<=10);send(frame('1',''));}
          else if(packet[0]===68){const [name]=stringAt(packet,6),count=statementParameters.get(name)??0,types=Buffer.alloc(2+count*4);types.writeUInt16BE(count);
            for(let i=0;i<count;i++)types.writeUInt32BE(25,2+i*4);
            const metadata=Buffer.concat([frame('t',types),frame('n','')]);
            if(holdDescribe){described.resolve();void describeRelease.promise.then(()=>{if(!socket.destroyed)send(metadata);});}else send(metadata);}
          else if(packet[0]===66){const [portal,start]=stringAt(packet,5),[statement]=stringAt(packet,start);assert.ok(statements.has(statement));portals.set(portal,statements.get(statement));send(frame('2',''));}
          else if(packet[0]===69){const [portal]=stringAt(packet,5);assert.ok(portals.has(portal));execute(portals.get(portal));}
          else if(packet[0]===83)ready();
          else if(packet[0]===72){/* Flush: all fixture responses already written. */}
          else if(packet[0]===88)socket.end();else throw new Error('Unexpected protocol frame '+packet[0]);
        }
      }catch(error){failure??=error;socket.destroy();}
    });
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  let faultArmed=false,faultAttempts=0,faultThrown=false,acceptedFaultWrites=0,faultCloseAllowed=false;
  const heldDestroys=[],faultResponse=deferred();
  const releaseFaultClose=()=>{faultCloseAllowed=true;for(const perform of heldDestroys.splice(0))perform();};
  const heldPrimaryDestroys=[];let primaryCloseAllowed=false;
  const releasePrimaryClose=()=>{primaryCloseAllowed=true;for(const perform of heldPrimaryDestroys.splice(0))perform();};
  const rawClosed=deferred(),rawCloseRequested=deferred();let gatedSocket,originalDestroy;
  const emitSyntheticPrimaryClose=()=>{assert.ok(rawCloseGate&&gatedSocket);gatedSocket.emit('close');};
  const releaseRawClose=()=>{assert.ok(rawCloseGate&&gatedSocket);Reflect.apply(originalDestroy,gatedSocket,[]);rawClosed.resolve();};
  const rejectRawClose=()=>{assert.ok(rawCloseGate);rawClosed.reject(new Error('synthetic raw closure failure'));};
  const cancelRawClosed=deferred(),cancelRawCloseRequested=deferred();let gatedCancelSocket,originalCancelDestroy,cancelRawCloseCalls=0;
  const emitSyntheticCancelClose=()=>{assert.ok(cancelRawCloseGate&&gatedCancelSocket);gatedCancelSocket.emit('close');};
  const releaseCancelRawClose=()=>{assert.ok(cancelRawCloseGate&&gatedCancelSocket);Reflect.apply(originalCancelDestroy,gatedCancelSocket,[]);cancelRawClosed.resolve();};
  const rejectCancelRawClose=()=>{assert.ok(cancelRawCloseGate);cancelRawClosed.reject(new Error('synthetic cancel raw closure failure'));};
  const faultError=Object.assign(new Error('synthetic socket.write failure'),{code:'SYNTHETIC_WRITE_FAILURE'});
  const customSocket=beginBackpressure||writeFault||beforeSocket||holdPrimaryClose||rawCloseGate||cancelRawCloseGate?()=>{
    // Keep synchronous factory throws distinct from an asynchronously rejected setup.
    const ordinal=++socketCreations,setup=beforeSocket?.(ordinal);
    return (async()=>{
    await setup;
    const socket=createConnection({host:'127.0.0.1',port:server.address().port});clientSockets.add(socket);
    socket.on('data',()=>{if(faultArmed&&faultThrown)faultResponse.resolve();});
    await once(socket,'connect');const nativeWrite=socket.write;
    const nativeDestroy=socket.destroy;
    if(rawCloseGate&&ordinal===1){
      gatedSocket=socket;originalDestroy=nativeDestroy;
      socket.raw={...(omitPrimaryRawClosed?{}:{closed:rawClosed.promise}),close:()=>{rawCloseRequested.resolve();return rawClosed.promise;}};
    }
    if(cancelRawCloseGate&&ordinal===2){
      gatedCancelSocket=socket;originalCancelDestroy=nativeDestroy;
      socket.raw={closed:cancelRawClosed.promise,close:()=>{cancelRawCloseCalls++;cancelRawCloseRequested.resolve();return cancelRawClosed.promise;}};
    }
    socket.destroy=function(...args){
      if(holdPrimaryClose&&ordinal===1&&!primaryCloseAllowed){heldPrimaryDestroys.push(()=>Reflect.apply(nativeDestroy,this,args));assert.ok(heldPrimaryDestroys.length<=2);return this;}
      if(writeFault?.holdClose&&faultThrown&&!faultCloseAllowed){heldDestroys.push(()=>Reflect.apply(nativeDestroy,this,args));assert.ok(heldDestroys.length<=4);return this;}
      return Reflect.apply(nativeDestroy,this,args);
    };
    socket.write=function(data,...args){
      if(faultArmed&&data.includes(Buffer.from(writeFault.marker))){
        faultAttempts++;
        if(!faultThrown){
          faultThrown=true;
          if(writeFault.acceptBeforeThrow){Reflect.apply(nativeWrite,this,[data,...args]);acceptedFaultWrites++;}
          throw faultError;
        }
        acceptedFaultWrites++;
      }
      const result=Reflect.apply(nativeWrite,this,[data,...args]);
      // Accepted bytes, synthetic backpressure signal. Large BEGIN options force
      // postgres.js to call nextWrite synchronously, instead of merely batching it.
      if(beginBackpressure&&data.length>=1024&&data.includes(Buffer.from('begin '))){forcedFalse++;assert.equal(forcedFalse,1);return false;}
      return result;
    };
    return socket;
    })();
  }:undefined;
  let raw;
  // Own teardown before awaiting the application's asynchronous initialization boundary.
  t.after(async()=>{release.resolve();describeRelease.resolve();releaseCancel();releaseFaultClose();releasePrimaryClose();if(rawCloseGate&&gatedSocket)releaseRawClose();if(cancelRawCloseGate&&gatedCancelSocket)releaseCancelRawClose();try{await raw?.end({timeout:0});}finally{
    for(const socket of sockets)socket.destroy();for(const socket of clientSockets)socket.destroy();
    await new Promise(yes=>server.close(yes));}assert.ifError(failure);});
  raw=await postgres({host:'127.0.0.1',port:server.address().port,database:'synthetic',username:'synthetic',password:'synthetic',
    ssl:false,fetch_types:false,prepare:false,max:1,max_pipeline:maxPipeline,connect_timeout:1,backoff:0,...(customSocket?{socket:customSocket}:{})});
  const initializationTrace=trace.splice(0),initializationStates=states.splice(0);
  assert.deepEqual(queries.splice(0),factoryInitializesSession?['SET search_path TO cinatoken_gateway, public']:[]);
  assert.deepEqual(initializationTrace,factoryInitializesSession?[{connectionId:1,query:'SET search_path TO cinatoken_gateway, public'}]:[]);
  assert.deepEqual(initializationStates,factoryInitializesSession?[{connectionId:1,query:'SET search_path TO cinatoken_gateway, public',transactionBefore:false}]:[]);
  // This shared peer also drives low-level arbitrary-SQL cancel protocol tests.
  const owner=ownPostgresRecoveryOperationsForDiagnostics({driver:'postgres',raw},()=>{});
  return {raw,owner,queries,trace,states,initializationTrace,entered:entered.promise,forcedFalse:()=>forcedFalse,
    cancelPackets,cancelled:cancelled.promise,releaseCancel,
    described:described.promise,releaseDescribe:()=>describeRelease.resolve(),
    armWriteFault:()=>{assert.ok(writeFault);faultArmed=true;},writeFaultState:()=>({attempts:faultAttempts,accepted:acceptedFaultWrites,thrown:faultThrown}),faultError,
    releaseFaultClose,releasePrimaryClose,emitSyntheticPrimaryClose,releaseRawClose,rejectRawClose,rawCloseRequested:rawCloseRequested.promise,
    emitSyntheticCancelClose,releaseCancelRawClose,rejectCancelRawClose,cancelRawCloseRequested:cancelRawCloseRequested.promise,cancelRawCloseCalls:()=>cancelRawCloseCalls,
    faultResponse:()=>faultResponse.promise,
    drainTransport:()=>{for(const socket of clientSockets)socket.emit('drain');},
    seen:query=>{if(queries.includes(query))return Promise.resolve();assert.ok(observers.size<10);const observed=deferred();observers.set(query,observed);return observed.promise;},
    release:()=>release.resolve(),disconnect:()=>{for(const socket of sockets)socket.destroy();}};
}

test('real postgres.js successful non-streaming transaction receives BEGIN/COMMIT completion before owner confirmation',{timeout:5000},async t=>{
  const p=await peer(t);
  await p.owner.client.raw.begin(async tx=>{assert.equal((await tx.unsafe('select fixture')).length,0);});
  assert.equal(await p.owner.drain(),'confirmed');assert.deepEqual(p.queries.map(x=>x.trim()),['begin','select fixture','commit']);
});
test('real postgres.js CommandComplete without ReadyForQuery does not release the statement owner',{timeout:5000},async t=>{
  const p=await peer(t,{holdReady:true});let finished=false;
  const operation=Promise.resolve(p.owner.client.raw.unsafe('select fixture')).then(x=>{finished=true;return x;});
  await p.entered;await tick();assert.equal(finished,false);assert.equal(p.owner.pending(),1);
  let drained=false;const drain=p.owner.drain().then(x=>{drained=true;return x;});await tick();assert.equal(drained,false);
  p.release();await operation;assert.equal(await drain,'confirmed');
});
test('real postgres.js onclose rejects begin before its callback ends; owner waits and rejects callback SQL after closure',{timeout:5000},async t=>{
  const p=await peer(t),gate=deferred(),entered=deferred();let callbackEnded=false,lateRejected=false;
  const transaction=p.owner.client.raw.begin(async tx=>{
    await tx.unsafe('select first');entered.resolve();await gate.promise;
    try{await tx.unsafe('select forbidden_late');}catch{lateRejected=true;throw new Error('synthetic late callback stopped');}
    finally{callbackEnded=true;}
  });
  await entered.promise;p.disconnect();await assert.rejects(transaction);assert.equal(callbackEnded,false);assert.equal(p.owner.unconfirmed(),true);
  let drained=false;const drain=p.owner.drain().then(x=>{drained=true;return x;});await tick();assert.equal(drained,false);
  gate.resolve();assert.equal(await drain,'unconfirmed');assert.equal(callbackEnded,true);assert.equal(lateRejected,true);
  // Let driver-internal rollback scheduling run BEFORE fixture client teardown, to separate
  // the onclose path from a test-induced end({timeout:0})/queued-write race.
  await tick();await tick();
  assert.ok(!p.queries.some(q=>q.includes('forbidden_late')));
  // Internal driver rollback after callback failure is not a cleanup receipt; capacity stays
  // unconfirmed. t.after closes this test-owned client only, never a caller's shared pool.
});
