/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesSseSnapshotStagingGateway } from './images-sse-snapshot-gateway-handler-v2';

export default createImagesSseSnapshotStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
