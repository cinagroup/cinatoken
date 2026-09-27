/// <reference path="./images-env.d.ts" />
import {env} from 'cloudflare:workers';
import {createImagesSsePeerDiagnosticGateway} from './images-sse-capacity-peer-diagnostic-handler';

// Separate opt-in entry: production and the frozen V3 artifact are unchanged.
export default createImagesSsePeerDiagnosticGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
