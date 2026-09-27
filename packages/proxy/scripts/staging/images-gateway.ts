/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesStagingGateway } from './images-gateway-handler';

// Explicit composition only. No global fetch replacement, body rewriting, or fake SQL results.
// The production index still creates its default application with native fetch.
// Legacy staging deliberately retains its recovery-disabled behavior.
export default createImagesStagingGateway((input, init) => env.IMAGE_UPSTREAM.fetch(input, init));
