/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseCapacityPeerGatewayV2} from './images-sse-capacity-peer-handler-v2';

export default createImagesSseCapacityPeerGatewayV2((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
