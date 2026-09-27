import {imagesSseCapacityPeerStagingConfig} from './prepare-staging-sse-capacity-peer.mjs';

/** Closed candidate with causal observation barriers; never deploys. */
export function imagesSseCapacityPeerV2StagingConfig(staging, production) {
  return {...imagesSseCapacityPeerStagingConfig(staging, production),
    main: 'scripts/staging/images-sse-capacity-peer-gateway-v2.ts'};
}
