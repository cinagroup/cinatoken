import { imagesStagingConfig } from './prepare-proxy-staging-images.mjs';

/** Same closed isolated staging bindings. No deploy, cloud call, or user-defined timeout. */
export function imagesHostExpiryStagingConfig(staging,production) {
  return {...imagesStagingConfig(staging,production),main:'scripts/staging/images-host-expiry-gateway.ts'};
}
