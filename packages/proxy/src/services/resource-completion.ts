/** Confirmation of registered cleanup work, not a physical heap/runtime measurement. */
export type ResourceCompletionOutcome = 'confirmed' | 'unconfirmed';
export type ResourceCompletion = Promise<ResourceCompletionOutcome>;

/** Observe cleanup without exposing errors or turning rejection into confirmation. */
export function observeResourceCleanup(operation: () => Promise<unknown>): ResourceCompletion {
	try { return operation().then(() => 'confirmed' as const, () => 'unconfirmed' as const); }
	catch { return Promise.resolve('unconfirmed'); }
}

/** Request-local fan-in. Usage settlement must never await this channel. */
export function createResourceCompletionGroup() {
	let pending = 0;
	let sealed = false;
	let outcome: ResourceCompletionOutcome = 'confirmed';
	let resolve!: (value: ResourceCompletionOutcome) => void;
	const completion: ResourceCompletion = new Promise(done => { resolve = done; });
	const finish = () => { if (sealed && pending === 0) resolve(outcome); };
	return {
		completion,
		track(task: ResourceCompletion): void {
			if (sealed) {
				void task.catch(() => undefined);
				throw new Error('Resource completion group is sealed');
			}
			pending++;
			void task.then(value => {
				if (value !== 'confirmed') outcome = 'unconfirmed';
			}, () => { outcome = 'unconfirmed'; }).then(() => { pending--; finish(); });
		},
		seal(): void { sealed = true; finish(); },
	};
}
