import type { Context } from 'hono';
import { retainCapacityUntilSettled, type RequestCapacityLease } from '../services/request-capacity';

const nodeBackgroundTasks = new Set<Promise<void>>();

function trackNodeBackgroundTask(task: Promise<unknown>): void {
	let tracked!: Promise<void>;
	tracked = task
		.then(() => undefined)
		.catch((err: unknown) => {
			console.error(
				'[Gateway Proxy] background task rejected (Node runtime, no ExecutionContext)',
				err instanceof Error ? err.message : String(err),
			);
		})
		.finally(() => {
			nodeBackgroundTasks.delete(tracked);
		});
	nodeBackgroundTasks.add(tracked);
}

/** Allows the Node host to drain managed accounting work during graceful shutdown. */
export async function drainNodeBackgroundWork(): Promise<void> {
	while (nodeBackgroundTasks.size > 0) {
		await Promise.allSettled([...nodeBackgroundTasks]);
	}
}

export function pendingNodeBackgroundWorkForTests(): number {
	return nodeBackgroundTasks.size;
}

/**
 * Cloudflare Workers：用 `ExecutionContext.waitUntil` 延长请求生命周期以跑异步记账等。
 * Node（Docker / `@hono/node-server`）：无 ExecutionContext，访问 `c.executionCtx` 会抛错；
 * Node 降级到进程级受管 Promise 集合；请求响应不阻塞，优雅停机时可显式 drain。
 */
export function scheduleBackgroundWork(c: {
	get(key: 'requestCapacityLease'): RequestCapacityLease | undefined;
	readonly executionCtx: Pick<Context['executionCtx'], 'waitUntil'>;
}, task: Promise<unknown>): void {
	const lease = c.get('requestCapacityLease');
	// Register synchronously before handoff. Response EOF and usage availability
	// are not completion of the accounting promise passed by the route.
	const ownedTask = lease ? retainCapacityUntilSettled(lease, task) : task;
	try {
		c.executionCtx.waitUntil(ownedTask);
	} catch {
		trackNodeBackgroundTask(ownedTask);
	}
}
