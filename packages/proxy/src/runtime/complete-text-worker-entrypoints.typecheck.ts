// Check Cloudflare entrypoint contracts in the Proxy's Workers type context.
// Node cutover scripts also import these Workers; their Node Request/Response
// globals are intentionally separate from Cloudflare's definitions.
import type { ExportedHandler } from '@cloudflare/workers-types';
import type { CompleteTextHolderV390Env } from './complete-text-holder-v390-env';
import type { CompleteTextResponseHolderV394Env } from './complete-text-response-holder-v394-env';

type AssertHandler<T extends ExportedHandler<Env>, Env> = T;
type HolderHandler = AssertHandler<
  typeof import('./complete-text-holder-worker-v390').default,
  CompleteTextHolderV390Env
>;
type ResponseHolderHandler = AssertHandler<
  typeof import('./complete-text-response-holder-worker-v394').default,
  CompleteTextResponseHolderV394Env
>;

export type CompleteTextWorkerHandlersChecked = [HolderHandler, ResponseHolderHandler];
