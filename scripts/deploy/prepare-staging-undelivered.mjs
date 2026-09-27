import { imagesFencingStagingConfig } from './prepare-proxy-staging-images.mjs';

/** Same closed, isolated staging bindings; this function does not deploy or call a cloud API. */
export function imagesUndeliveredStagingConfig(staging,production) {
  return {...imagesFencingStagingConfig(staging,production),main:'scripts/staging/images-undelivered-gateway.ts'};
}
