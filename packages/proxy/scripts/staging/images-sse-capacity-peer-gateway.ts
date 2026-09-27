/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseCapacityPeerGateway} from './images-sse-capacity-peer-handler';

export default createImagesSseCapacityPeerGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
