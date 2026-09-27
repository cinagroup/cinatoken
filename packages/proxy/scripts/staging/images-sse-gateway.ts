/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesSseStagingGateway } from './images-sse-gateway-handler';

// Separate staging entry, same production gateway; no storage fault facade or deadline override.
export default createImagesSseStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
