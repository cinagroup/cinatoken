/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseHostExpiryGateway} from './images-sse-host-expiry-gateway-handler';

export default createImagesSseHostExpiryGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
