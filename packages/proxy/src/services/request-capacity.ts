/** Logical reservations, not a heap meter or a distributed concurrency limit. */
export type RequestCapacityLimits = {
	readonly maxRequests: number;
	readonly maxReservedBytes: number;
};

export type RequestCapacityLease = {
	/** Acquire before handing work to another owner. Cannot resurrect a returned lease. */
	retain(): () => void;
	/** Release the initial handler owner, once. Other owners remain independent. */
	release(): void;
};

export type RequestCapacityPool = {
	tryAcquire(reservedBytes: number): RequestCapacityLease | null;
	snapshot(): Readonly<RequestCapacityLimits & { requests: number; reservedBytes: number }>;
};

export function assertCapacityInteger(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Capacity must be a positive safe integer');
}

/**
 * One pool per explicitly selected runtime instance. Synchronous admission has
 * no await gap or waiter queue. The pool holds only numeric totals/limits, never
 * requests, credentials, bodies, promises or a registry of leases. Callers must
 * derive conservative reservations from a separately validated runtime profile.
 */
export function createRequestCapacityPool(limits: RequestCapacityLimits): RequestCapacityPool {
	const { maxRequests, maxReservedBytes } = limits;
	assertCapacityInteger(maxRequests);
	assertCapacityInteger(maxReservedBytes);
	let requests = 0;
	let reservedBytes = 0;
	return {
		snapshot: () => ({ maxRequests, maxReservedBytes, requests, reservedBytes }),
		tryAcquire(bytes) {
			assertCapacityInteger(bytes);
			// Subtraction avoids overflow even at Number.MAX_SAFE_INTEGER.
			if (requests >= maxRequests || bytes > maxReservedBytes - reservedBytes) return null;
			requests++;
			reservedBytes += bytes;
			let owners = 0;
			const retain = (): (() => void) => {
				owners++;
				let released = false;
				return () => {
					if (released) return;
					released = true;
					if (--owners === 0) { requests--; reservedBytes -= bytes; }
				};
			};
			const release = retain();
			return {
				release,
				retain() {
					if (owners === 0) throw new Error('Request capacity lease has already been returned');
					return retain();
				},
			};
		},
	};
}

/** Observe the actual promise terminal state, preserving both values and rejections. */
export function retainCapacityUntilSettled<T>(lease: RequestCapacityLease, task: Promise<T>): Promise<T> {
	let release: () => void;
	try { release = lease.retain(); }
	catch (error) {
		// Existing callers supply already-started promises. Never leave a rejected
		// task unobserved if a caller violates the registration-before-idle contract.
		void task.catch(() => undefined);
		throw error;
	}
	return task.finally(release);
}
