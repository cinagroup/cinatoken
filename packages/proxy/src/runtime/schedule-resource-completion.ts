import type { Context } from 'hono';
import type { RequestCapacityLease } from '../services/request-capacity';
import type { ResourceCompletion } from '../services/resource-completion';

// Separate from accounting: an untrusted cancellation ACK may never arrive.
const nodeResourceTasks = new Set<Promise<void>>();

export async function drainNodeResourceWork(): Promise<void> {
	while (nodeResourceTasks.size > 0) await Promise.allSettled([...nodeResourceTasks]);
}

export function pendingNodeResourceWorkForTests(): number { return nodeResourceTasks.size; }

export function scheduleResourceCompletion(c: {
	get(key: 'requestCapacityLease'): RequestCapacityLease | undefined;
	readonly executionCtx: Pick<Context['executionCtx'], 'waitUntil'>;
}, task: ResourceCompletion): void {
	let release: (() => void) | undefined;
	try { release = c.get('requestCapacityLease')?.retain(); }
	catch (error) { void task.catch(() => undefined); throw error; }
	const owned = task.catch(() => 'unconfirmed' as const).then(outcome => {
		if (outcome === 'confirmed') release?.();
		else {
			// Fail closed: keep only the numeric reservation, never payloads or errors.
			console.warn(JSON.stringify({ event: 'gateway.resource_cleanup_unconfirmed' }));
		}
	});
	try { c.executionCtx.waitUntil(owned); }
	catch {
		let tracked!: Promise<void>;
		tracked = owned.finally(() => { nodeResourceTasks.delete(tracked); });
		nodeResourceTasks.add(tracked);
	}
}
