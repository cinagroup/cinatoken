/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSseCapacityHostGateway} from './images-sse-capacity-host-handler';

export default createImagesSseCapacityHostGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
