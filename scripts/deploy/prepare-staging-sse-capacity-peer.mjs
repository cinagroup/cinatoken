import {imagesSseCapacityStagingConfig} from './prepare-staging-sse-capacity.mjs';

/** Pure closed candidate. Does not create resources, open ingress or deploy. */
export function imagesSseCapacityPeerStagingConfig(staging, production) {
  return {...imagesSseCapacityStagingConfig(staging, production),
    main: 'scripts/staging/images-sse-capacity-peer-gateway.ts'};
}
