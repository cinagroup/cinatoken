/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseCapacityPeerGatewayV3} from './images-sse-capacity-peer-handler-v3';

export default createImagesSseCapacityPeerGatewayV3((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
