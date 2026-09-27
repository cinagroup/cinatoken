/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseCancelStagingGateway} from './images-sse-cancel-gateway-handler';

export default createImagesSseCancelStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
