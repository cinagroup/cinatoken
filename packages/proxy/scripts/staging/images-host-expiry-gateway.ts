/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesHostExpiryGateway } from './images-host-expiry-handler';

// Separate opt-in staging artifact. Normal response delivery remains unchanged.
export default createImagesHostExpiryGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
