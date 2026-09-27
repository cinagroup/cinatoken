/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesSseSnapshotStagingGateway } from './images-sse-snapshot-gateway-handler';

export default createImagesSseSnapshotStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
