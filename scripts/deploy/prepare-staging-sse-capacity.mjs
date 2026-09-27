import {imagesStagingConfig} from './prepare-proxy-staging-images.mjs';

/** Closed, isolated HTTP-only candidate. Pure transformation; never deploys. */
export function imagesSseCapacityStagingConfig(staging,production){
  return {...imagesStagingConfig(staging,production),main:'scripts/staging/images-sse-capacity-host-gateway.ts'};
}
