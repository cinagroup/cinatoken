/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesFencingGateway } from './images-fencing-handler';

// Staging-only short-lease candidate; neither production nor the default recovery entry imports it.
export default createImagesFencingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
