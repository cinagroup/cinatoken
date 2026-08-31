import type { Context } from 'hono';

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
export function scheduleBackgroundWork(c: Context, task: Promise<unknown>): void {
	try {
		c.executionCtx.waitUntil(task);
	} catch {
		trackNodeBackgroundTask(task);
	}
}
