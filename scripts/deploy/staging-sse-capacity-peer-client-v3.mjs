import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';
import {PEER_V3_WATCH_URL, PEER_V3_STAGES, assertSseCapacityPrimaryV3,
  createSseCapacityPeerV3Parser, isSseCapacityPeerV3Mismatch} from './staging-sse-capacity-peer-protocol-v3.mjs';

export const PEER_V3_CLIENT_LIMITS = Object.freeze({upgrades:8, discoveryMs:20000, handshakeMs:5000,
  rejectionMs:1000, journalMs:1000, phaseMs:5000, lifetimeMs:180000, rejectionBytes:512, rejectionChunks:64});
const freeze = value => {if(value && typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
const copy = value => freeze(structuredClone(value));
const noop = () => {};
class PeerError extends Error {constructor(code){super(code);this.code=code;}}
const deferred = () => {const d=Promise.withResolvers();void d.promise.catch(noop);return d;};
const headersFrom = response => {
  const raw=response.rawHeaders;assert.ok(Array.isArray(raw) && raw.length%2===0 && raw.length<=256);
  let bytes=0;const headers=new Headers(),seen=new Set();
  for(let i=0;i<raw.length;i+=2){
    assert.equal(typeof raw[i],'string');assert.equal(typeof raw[i+1],'string');bytes+=Buffer.byteLength(raw[i])+Buffer.byteLength(raw[i+1]);
    assert.ok(bytes<=16384);const name=raw[i].toLowerCase();
    // A duplicated identity/cache/framing header cannot silently use last-wins.
    if(name!=='set-cookie'){assert.ok(!seen.has(name));seen.add(name);}
    headers.append(name,raw[i+1]);
  }
  return headers;
};

/** Node observer ONLY. No inference, recovery, management API, primary body or
 * lease ownership. socketFactory is dependency injection for loopback testing;
 * the production default always uses the fixed WSS endpoint and TLS validation.
 * The future native/D1 oracle must join primary DTO provenance to the original
 * actual Response/session. This client cannot establish native/financial proof.
 */
export function createSseCapacityPeerClientV3({clock,reserve,persist,socketFactory=(url,options)=>new WebSocket(url,options)}) {
  assert.equal(typeof reserve,'function');assert.equal(typeof persist,'function');assert.equal(typeof socketFactory,'function');
  assertOperatorSample(clock.sample(),clock.clockId);
  const lifetime=new AbortController(), upgrades=[], records=[];
  let primary,parser,credentials,owned,phasePending,activeRecord,previousFinished;
  let started=false,busy=false,stopped=false,failed=false,error,endedAt,sealed,lifetimeTimer,journalPending=false,journalUnconfirmed=false;
  let markerAttempts=0;
  const snapshot=()=>copy({profile:'c02-sse-peer-client-v3',primary,stopped,failed,error,endedAt,
    journalPending,journalUnconfirmed,upgradeAttempts:upgrades.length,markerAttempts,upgrades,records,
    parser:parser?.stats(),nativeVerified:false,c02GatePassed:false,isolateEvictionProven:false});
  const dispose=owner=>{
    if(!owner)return;owner.active=false;
    for(const [emitter,event,handler] of owner.listeners)emitter.off(event,handler);
    owner.listeners=[];
    // ws can emit a scheduled error after terminate() while CONNECTING. These
    // sinks retain no client state and never append evidence after sealing.
    owner.socket?.on('error',noop);
    owner.socket?.on('unexpected-response',(_request,response)=>{response.on('error',noop);response.destroy();});
    owner.response?.on('error',noop);try{owner.response?.destroy();}catch{}
    try{owner.socket?.terminate();}catch{}
    if(owned===owner)owned=undefined;
  };
  const stop=(code='operator_stop',asFailure=false)=>{
    if(stopped)return sealed;
    asFailure=asFailure||busy||journalPending;
    if(activeRecord?.result==='PENDING'){
      activeRecord.result='FAIL';activeRecord.error=code;activeRecord.finished=clock.sample();asFailure=true;
    }
    for(const row of upgrades)if(row.result==='PENDING'){row.result='FAIL';row.error=code;row.finished=clock.sample();}
    stopped=true;failed=asFailure;error=asFailure?code:undefined;endedAt=clock.sample();
    journalUnconfirmed=journalUnconfirmed||journalPending;credentials=undefined;clearTimeout(lifetimeTimer);
    sealed=snapshot();lifetime.abort();dispose(owned);phasePending=undefined;
    return sealed;
  };
  const fail=code=>{stop(code,true);return new PeerError(code);};
  const live=()=>{if(stopped)throw new PeerError(error??'stopped');};
  const bounded=async(work,ms,code,outerDeadline)=>{
    live();const own=clock.after(clock.sample(),ms),deadline=outerDeadline&&outerDeadline.atMs<own.atMs?outerDeadline:own;
    if(clock.remaining(deadline)===0)throw new PeerError(code);
    let timer,onAbort;
    const timeout=new Promise((_,reject)=>{
      onAbort=()=>reject(new PeerError(error??'stopped'));lifetime.signal.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>reject(new PeerError(code)),clock.remaining(deadline));
    });
    try{
      const value=await Promise.race([Promise.resolve().then(()=>{live();return work();}),timeout]);
      live();if(clock.remaining(deadline)===0)throw new PeerError(code);return value;
    }finally{clearTimeout(timer);lifetime.signal.removeEventListener('abort',onAbort);}
  };
  const save=async(row,deadline)=>{
    live();journalPending=true;
    try{await bounded(()=>persist(copy(row)),PEER_V3_CLIENT_LIMITS.journalMs,'journal',deadline);}
    catch{if(!stopped)journalUnconfirmed=true;throw new PeerError('journal');}
    finally{if(!stopped)journalPending=false;}
  };
  const listen=(owner,emitter,event,handler)=>{emitter.on(event,handler);owner.listeners.push([emitter,event,handler]);};
  const rejection=async(owner,response,row,deadline)=>{
    const outcome=deferred(),chunks=[];let bytes=0,count=0;
    const alive=()=>owner.active&&!stopped;
    listen(owner,response,'data',chunk=>{
      if(!alive())return;
      try{assert.ok(chunk instanceof Uint8Array&&chunk.length>0);assert.ok(++count<=64&&bytes+chunk.length<=512);
        bytes+=chunk.length;chunks.push(Buffer.from(chunk));row.rejectionBytes=bytes;
      }catch{outcome.reject(new PeerError('rejection_bound'));}
    });
    listen(owner,response,'end',()=>{
      if(!alive())return;
      try{
        assert.equal(response.complete,true);const body=Buffer.concat(chunks,bytes);
        row.rejectionComplete=true;row.rejectionSha256=createHash('sha256').update(body).digest('hex');
        outcome.resolve(isSseCapacityPeerV3Mismatch({status:response.statusCode,headers:headersFrom(response),body,complete:true}));
      }catch{outcome.reject(new PeerError('rejection_contract'));}
    });
    listen(owner,response,'error',()=>outcome.reject(new PeerError('rejection_truncated')));
    listen(owner,response,'aborted',()=>outcome.reject(new PeerError('rejection_truncated')));
    return bounded(()=>outcome.promise,PEER_V3_CLIENT_LIMITS.rejectionMs,'rejection_timeout',deadline);
  };
  const connect=async(row,baseline,deadline)=>{
    const result=deferred(),owner={active:true,listeners:[],socket:undefined,response:undefined,upgraded:false,opened:false};owned=owner;
    const alive=()=>owner.active&&!stopped;
    const failOwner=code=>{if(alive())result.reject(fail(code));};
    try{
      const headers=Object.fromEntries(credentials);headers['x-c02-capacity-watch']='v3';headers['x-c02-capacity-peer']=primary.peer;
      row.dispatched=clock.sample();
      owner.socket=socketFactory(PEER_V3_WATCH_URL,{headers,followRedirects:false,perMessageDeflate:false,
        maxPayload:512,maxFragments:512,maxBufferedChunks:512,maxHeaderSize:16384,autoPong:false,
        handshakeTimeout:Math.min(PEER_V3_CLIENT_LIMITS.handshakeMs,clock.remaining(deadline))});
      const socket=owner.socket;
      listen(owner,socket,'error',()=>failOwner('socket_error'));
      listen(owner,socket,'close',()=>failOwner('socket_closed'));
      listen(owner,socket,'ping',()=>failOwner('unexpected_control'));
      listen(owner,socket,'pong',()=>failOwner('unexpected_control'));
      listen(owner,socket,'upgrade',response=>{
        if(!alive())return;
        try{
          assert.equal(owner.upgraded,false);owner.upgraded=true;row.status=response.statusCode;row.headersAt=clock.sample();
          const h=headersFrom(response);assert.equal(response.statusCode,101);
          assert.equal(h.get('x-c02-capacity-watch'),'v3');assert.equal(h.get('x-c02-capacity-peer'),primary.peer);
          assert.equal(h.get('x-c02-capacity-instance'),primary.instanceId);assert.equal(h.get('cache-control'),'no-store');
          assert.equal(h.has('location'),false);assert.equal(h.has('x-generation-id'),false);
        }catch{failOwner('upgrade_contract');}
      });
      listen(owner,socket,'open',()=>{
        if(!alive())return;
        if(!owner.upgraded)return failOwner('upgrade_unconfirmed');
        owner.opened=true;row.openedAt=clock.sample();
      });
      listen(owner,socket,'message',(data,isBinary)=>{
        if(!alive())return;
        try{
          assert.equal(owner.opened,true);const frame=parser.pushMessage(data,isBinary),received=clock.sample();
          if(frame.kind==='end'){
            if(records.length===4&&records.every(r=>r.result==='PASS')&&!journalPending)stop('protocol_end');
            else failOwner('observer_end');return;
          }
          if(frame.kind==='sample'&&frame.sequence===1){
            baseline.status=101;baseline.sample=frame;baseline.received=received;baseline.upgradeAttempt=row.attempt;
            result.resolve('MATCH');return;
          }
          if(frame.kind==='barrier'){
            assert.ok(phasePending&&frame.barrier===phasePending.target);
            phasePending.record.barrier=frame;phasePending.record.acknowledged=received;
          }else if(phasePending&&frame.barrier===phasePending.target&&!phasePending.record.sample){
            assert.ok(phasePending.record.barrier);phasePending.record.sample=frame;phasePending.record.received=received;
            phasePending.done.resolve();
          }
        }catch{failOwner('message_contract');}
      });
      listen(owner,socket,'unexpected-response',(_request,response)=>{
        if(!alive()){response.on('error',noop);response.destroy();return;}
        if(owner.upgraded||owner.response)return failOwner('upgrade_ambiguous');
        owner.response=response;row.status=response.statusCode;row.headersAt=clock.sample();
        void rejection(owner,response,row,deadline).then(mismatch=>{
          if(!alive())return;
          if(!mismatch)return failOwner('upgrade_rejected');
          row.finished=clock.sample();row.result='MISMATCH';dispose(owner);result.resolve('MISMATCH');
        }).catch(e=>failOwner(e instanceof PeerError?e.code:'rejection_contract'));
      });
      return await bounded(()=>result.promise,PEER_V3_CLIENT_LIMITS.handshakeMs,'upgrade_timeout',deadline);
    }catch(e){dispose(owner);throw e;}
  };
  const guarded=async(work)=>{
    if(busy||stopped)throw new PeerError('client_unavailable');busy=true;
    try{return await work();}
    catch(e){throw fail(e instanceof PeerError?e.code:'contract_or_transport');}
    finally{busy=false;activeRecord=undefined;}
  };
  return Object.freeze({
    open(primaryEvidence,accessHeaders){
      return guarded(async()=>{
        assert.equal(started,false);started=true;primary=assertSseCapacityPrimaryV3(primaryEvidence,clock.clockId);
        const now=clock.sample();assert.ok(now.monoMs>=primary.received.monoMs);
        const deadline=clock.after(primary.received,PEER_V3_CLIENT_LIMITS.discoveryMs);assert.ok(clock.remaining(deadline)>0);
        credentials=new Headers(accessHeaders);
        assert.deepEqual([...credentials.keys()].sort(),['cf-access-client-id','cf-access-client-secret']);
        for(const v of credentials.values())assert.ok(v.length>0&&v.length<=4096);
        parser=createSseCapacityPeerV3Parser(primary.peer);
        lifetimeTimer=setTimeout(()=>fail('observer_timeout'),clock.remaining(clock.after(primary.received,PEER_V3_CLIENT_LIMITS.lifetimeMs)));
        const baseline={kind:'capacity-peer-v3',stage:'baseline',peer:primary.peer,started:now,result:'PENDING'};
        records.push(baseline);activeRecord=baseline;
        for(let attempt=1;attempt<=PEER_V3_CLIENT_LIMITS.upgrades;attempt++){
          live();if(clock.remaining(deadline)===0)throw new PeerError('discovery_timeout');
          const row={kind:'capacity-peer-v3-upgrade',attempt,peer:primary.peer,started:clock.sample(),result:'PENDING'};upgrades.push(row);
          try{assert.equal(reserve(),undefined);}catch{throw new PeerError('budget');}
          await save(row,deadline);live();
          if(clock.remaining(deadline)===0)throw new PeerError('discovery_timeout');
          const outcome=await connect(row,baseline,deadline);live();
          row.result=outcome;row.finished=clock.sample();await save(row,deadline);
          if(outcome==='MISMATCH')continue;
          baseline.finished=clock.sample();baseline.result='PASS';await save(baseline,deadline);
          live();previousFinished=baseline.finished;return copy(baseline);
        }
        throw new PeerError('discovery_exhausted');
      });
    },
    phase(stage,{after}){
      return guarded(async()=>{
        assert.ok(started&&records[0]?.result==='PASS'&&owned?.opened);
        assert.equal(stage,PEER_V3_STAGES[markerAttempts]);
        const prerequisite=assertOperatorSample(after,clock.clockId),now=clock.sample();
        assert.ok(prerequisite>=previousFinished.monoMs&&prerequisite<=now.monoMs);
        const row={kind:'capacity-peer-v3',stage,peer:primary.peer,attempt:++markerAttempts,prerequisite:copy(after),started:now,result:'PENDING'};
        records.push(row);activeRecord=row;
        await save(row);live();
        const command=parser.mark(stage),done=deferred(),sent=deferred();phasePending={target:markerAttempts,record:row,done};
        await bounded(()=>{
          row.sent=clock.sample();
          owned.socket.send(command,{binary:false,compress:false},err=>{
            if(stopped)return;
            if(err)sent.reject(new PeerError('marker_send'));else{row.sendConfirmed=clock.sample();sent.resolve();}
          });
          return Promise.all([done.promise,sent.promise]);
        },PEER_V3_CLIENT_LIMITS.phaseMs,'marker_timeout');
        phasePending=undefined;row.finished=clock.sample();row.result='PASS';await save(row);
        live();previousFinished=row.finished;return copy(row);
      });
    },
    stop:()=>stop(),report:()=>sealed??snapshot(),
  });
}
