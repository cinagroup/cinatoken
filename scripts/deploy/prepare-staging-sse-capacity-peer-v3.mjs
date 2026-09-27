import {imagesSseCapacityPeerStagingConfig} from './prepare-staging-sse-capacity-peer.mjs';

/** Pure closed configuration; no automatic deploy or new resource binding. */
export function imagesSseCapacityPeerV3StagingConfig(staging,production){
  return {...imagesSseCapacityPeerStagingConfig(staging,production),main:'scripts/staging/images-sse-capacity-peer-gateway-v3.ts'};
}
