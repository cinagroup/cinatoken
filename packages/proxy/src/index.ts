import { createWorkerHandler } from './runtime/worker-handler';

export type { Env } from './app';

export const workerHandler = createWorkerHandler();

export default workerHandler;
