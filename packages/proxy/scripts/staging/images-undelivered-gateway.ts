/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesUndeliveredGateway } from './images-undelivered-handler';

// Explicitly selected staging experiment only. Production/default entries do not import this.
export default createImagesUndeliveredGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
