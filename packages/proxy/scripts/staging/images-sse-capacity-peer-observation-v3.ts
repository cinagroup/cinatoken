/// <reference path="./images-env.d.ts" />
import type {HttpRequestCapacityPolicy} from '../../src/middleware/request-capacity';
import {observeImagesSseCapacity, SSE_CAPACITY_INSTANCE_HEADER, SSE_CAPACITY_ORIGIN, SSE_CAPACITY_PATH} from './images-sse-capacity-observation';

export const SSE_PEER_V3_PROFILE = 'c02-sse-peer-v3';
export const SSE_PEER_V3_PATH = '/__staging/sse-capacity/watch-v3';
export const SSE_PEER_V3_PRIMARY = 'x-c02-capacity-primary';
export const SSE_PEER_V3_HEADER = 'x-c02-capacity-peer';
export const SSE_PEER_V3_WATCH = 'x-c02-capacity-watch';
export const SSE_PEER_V3_BASELINE = 'x-c02-capacity-before';
export const SSE_PEER_V3_LIMITS = Object.freeze({lifetimeMs:180_000, intervalMs:1_000, samples:180, frameBytes:512, commandChars:128});
const stages = ['held', 'post-native', 'post-recovery'] as const;
const peerPattern = /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):([1-9][0-9]{0,15})$/;
type Handler = Pick<Required<ExportedHandler<ImagesStagingEnv>>, 'fetch'>;
const reject = (status:number, reason:string) => Response.json({status:'rejected',reason,dispatch_started:false},{status,headers:{'Cache-Control':'no-store'}});

/** Primary-first, staging-only diagnostic. One pool, numeric epochs only across
 * requests. The socket, listeners and timers are owned by its upgrade request.
 * No shared primary Request/Response/promise, no admission reset or new lease.
 * A matching upgrade proves local identity only, not isolate affinity/eviction. */
export function observeImagesSseCapacityPeerV3(build:(policy:HttpRequestCapacityPolicy)=>Handler):Handler {
  let policy:HttpRequestCapacityPolicy|undefined;
  const handler=observeImagesSseCapacity(value=>{policy=value;return build(value);});
  if(!policy)throw Error('Capacity policy unavailable');
  const pool=policy.pool;
  let primaryEpoch=0, pendingEpoch=0, eligibleEpoch=0, watchedEpoch=0, activeEpoch=0;
  return {
    async fetch(request,bindings,context){
      const url=new URL(request.url),headers=request.headers;
      if(url.origin!==SSE_CAPACITY_ORIGIN||bindings.DATABASE_DRIVER!=='d1'||bindings.REQUEST_BODY_LOGGING!=='off'||bindings.BATCH_API_ENABLED!=='false')
        return reject(404,'profile_unavailable');
      const watching=url.pathname===SSE_PEER_V3_PATH,inference=url.pathname==='/v1/images/generations';
      if(headers.has('x-c02-capacity-barrier'))return reject(400,'http_marker_unavailable');
      if(!watching&&!inference){
        if(headers.has(SSE_PEER_V3_PRIMARY)||headers.has(SSE_PEER_V3_WATCH)||headers.has(SSE_PEER_V3_HEADER)||headers.has(SSE_PEER_V3_BASELINE)
          ||url.pathname.startsWith('/__staging/sse-capacity/'))return reject(400,'unexpected_peer');
        return handler.fetch(request,bindings,context);
      }
      const peer=headers.get(SSE_PEER_V3_HEADER);
      const match=peer!==null&&peer.length<=53?peerPattern.exec(peer):null;
      if(watching){
        if(request.method!=='GET'||request.body!==null||url.search||url.hash||headers.get('Upgrade')?.toLowerCase()!=='websocket'
          ||headers.get(SSE_PEER_V3_WATCH)!=='v3'||headers.has(SSE_PEER_V3_PRIMARY)||headers.has(SSE_PEER_V3_BASELINE)
          ||!match||!Number.isSafeInteger(Number(match[2])))return reject(400,'invalid_watch');
      }else if(request.method!=='POST'||url.search||url.hash||headers.has('upgrade')||headers.get(SSE_PEER_V3_PRIMARY)!=='v3'
        ||peer!==null||headers.has(SSE_PEER_V3_WATCH)||headers.has(SSE_PEER_V3_BASELINE))return reject(400,'invalid_primary');
      if(request.signal.aborted)return reject(409,'request_aborted');
      const census=await handler.fetch(new Request(SSE_CAPACITY_ORIGIN+SSE_CAPACITY_PATH),bindings,context);
      const instanceId=census.headers.get(SSE_CAPACITY_INSTANCE_HEADER);await census.body?.cancel();
      if(census.status!==200||!instanceId)return reject(503,'identity_unavailable');
      if(request.signal.aborted)return reject(409,'request_aborted');
      if(inference){
        // Synchronous numeric exclusion before awaiting business preparation.
        // Snapshot is pre-dispatch evidence, never a physical memory estimate.
        const before=pool.snapshot();
        if(pendingEpoch||activeEpoch||before.requests!==0||before.reservedBytes!==0)return reject(409,'primary_busy');
        if(primaryEpoch===Number.MAX_SAFE_INTEGER)return reject(503,'primary_epoch_exhausted');
        const epoch=++primaryEpoch;pendingEpoch=epoch;eligibleEpoch=0;
        try{
          const response=await handler.fetch(request,bindings,context);
          const resultHeaders=new Headers(response.headers);
          resultHeaders.set(SSE_PEER_V3_PRIMARY,'v3');resultHeaders.set(SSE_PEER_V3_HEADER,`${instanceId}:${epoch}`);
          resultHeaders.set(SSE_PEER_V3_BASELINE,'0/0');
          if(response.status===200&&!request.signal.aborted)eligibleEpoch=epoch;
          return new Response(response.body,{status:response.status,statusText:response.statusText,headers:resultHeaders});
        }finally{if(pendingEpoch===epoch)pendingEpoch=0;}
      }
      if(!match||match[1]!==instanceId||Number(match[2])!==eligibleEpoch||eligibleEpoch===0)return reject(409,'peer_not_active_here');
      if(activeEpoch||watchedEpoch===eligibleEpoch)return reject(409,'watch_already_used');
      // Start only while the actual business pool is occupied. The native/D1
      // oracle must still tie that owner to the primary generation and clock.
      if(pool.snapshot().requests!==1)return reject(409,'primary_not_held');
      const epoch=eligibleEpoch;watchedEpoch=epoch;activeEpoch=epoch;
      let server:WebSocket|undefined, ended=false, sequence=0, barrier=0, timer:ReturnType<typeof setTimeout>|undefined;
      let deadline:ReturnType<typeof setTimeout>|undefined;
      const encoder=new TextEncoder();
      const cleanup=()=>{
        clearTimeout(timer);clearTimeout(deadline);timer=deadline=undefined;
        request.signal.removeEventListener('abort',onAbort);
        server?.removeEventListener('message',onMessage);server?.removeEventListener('close',onClose);server?.removeEventListener('error',onError);
        if(activeEpoch===epoch)activeEpoch=0;
      };
      const finish=(code:number,reason:string)=>{
        if(ended)return;ended=true;cleanup();try{server?.close(code,reason);}catch{}
      };
      const send=(record:object)=>{
        if(ended)return;
        const text=JSON.stringify(record);
        if(encoder.encode(text).byteLength>SSE_PEER_V3_LIMITS.frameBytes)throw Error('Peer frame bound');
        server?.send(text);
      };
      const common={profile:SSE_PEER_V3_PROFILE,instanceId,watchEpoch:epoch};
      const end=(reason:'deadline'|'sample-limit')=>{
        try{send({...common,kind:'end',reason});}catch{}finish(1000,reason);
      };
      const sample=()=>{
        if(ended)return;
        send({...common,kind:'sample',barrier,sequence:++sequence,...pool.snapshot()});
        if(sequence===SSE_PEER_V3_LIMITS.samples)end('sample-limit');
      };
      const tick=()=>{
        try{sample();if(!ended)timer=setTimeout(tick,SSE_PEER_V3_LIMITS.intervalMs);}catch{finish(1011,'send_failed');}
      };
      const onAbort=()=>finish(1001,'request_aborted');
      const onClose=()=>finish(1000,'peer_closed');
      const onError=()=>finish(1011,'peer_error');
      const onMessage=(event:MessageEvent)=>{
        if(ended)return;
        const stage=stages[barrier];
        // Compare fixed ASCII commands directly; no unbounded JSON parse.
        if(typeof event.data!=='string'||event.data.length>SSE_PEER_V3_LIMITS.commandChars||stage===undefined
          ||event.data!==JSON.stringify({profile:SSE_PEER_V3_PROFILE,kind:'mark',barrier:barrier+1,stage})){
          finish(1008,'invalid_marker');return;
        }
        try{
          barrier++;
          send({...common,kind:'barrier',barrier,stage});
          // This sample is ordered after the marker on the SAME connection.
          sample();
        }catch{finish(1011,'send_failed');}
      };
      try{
        const pair=new WebSocketPair();server=pair[1];server.accept();
        server.addEventListener('message',onMessage);server.addEventListener('close',onClose);server.addEventListener('error',onError);
        request.signal.addEventListener('abort',onAbort,{once:true});
        if(request.signal.aborted){finish(1001,'request_aborted');return reject(409,'request_aborted');}
        deadline=setTimeout(()=>end('deadline'),SSE_PEER_V3_LIMITS.lifetimeMs);tick();
        if(ended)return reject(503,'watch_setup_failed');
        return new Response(null,{status:101,webSocket:pair[0],headers:{'Cache-Control':'no-store',
          [SSE_CAPACITY_INSTANCE_HEADER]:instanceId,[SSE_PEER_V3_HEADER]:`${instanceId}:${epoch}`,[SSE_PEER_V3_WATCH]:'v3'}});
      }catch{finish(1011,'watch_setup_failed');return reject(503,'watch_setup_failed');}
    },
  };
}
