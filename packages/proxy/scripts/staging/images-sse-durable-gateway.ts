/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseDurableStagingGateway} from './images-sse-durable-gateway-handler';

export default createImagesSseDurableStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
