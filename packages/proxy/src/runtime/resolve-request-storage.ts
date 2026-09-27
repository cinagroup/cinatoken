import { postgresInitializationCleanup, type StorageContext } from '@octafuse/core';
import type { Context } from 'hono';
import type { Env, StorageResolver } from '../app';
import { observeResourceCleanup } from '../services/resource-completion';
import { scheduleResourceCompletion } from './schedule-resource-completion';

/** Only runtimes with an explicit unused-result contract may detach initialization. */
export async function resolveRequestStorage(
	c: Context<Env>,
	resolveStorage: StorageResolver,
	disposeUnusedStorage?: (storage: StorageContext) => Promise<void>,
): Promise<StorageContext> {
	const deadline = c.get('textRequestLifecycle')?.deadline;
	if (!deadline || !disposeUnusedStorage) return resolveStorage(c);
	deadline.throwIfStopped();
	let handedOff = false;
	let decide!: () => void;
	const decision = new Promise<void>(resolve => { decide = resolve; });
	const pending = Promise.resolve().then(() => { deadline.throwIfStopped(); return resolveStorage(c); });
	const cleanup = pending.then(async storage => {
		// Include the gap between resolution and the awaiting caller's continuation.
		await decision;
		if (!handedOff) await disposeUnusedStorage(storage);
	}, error => {
		// Only the initializer which owned and closed the unpublished client can
		// confirm failure cleanup. An arbitrary rejected resolver is not proof.
		if (postgresInitializationCleanup(error) !== 'confirmed') throw error;
	});
	try {
		scheduleResourceCompletion(c, observeResourceCleanup(() => cleanup));
		const storage = await deadline.wait(() => pending);
		deadline.throwIfStopped();
		handedOff = true;
		return storage;
	} finally { decide(); }
}
