export class RequestExecutionStoppedError extends Error {
	constructor(readonly reason: 'deadline_exceeded' | 'client_cancelled') {
		super(reason === 'deadline_exceeded' ? 'Request deadline exceeded' : 'Request was cancelled');
		this.name = 'RequestExecutionStoppedError';
	}
}

export type DeadlineClock = {
	now(): number;
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
};

const CLOCK: DeadlineClock = {
	now: () => Date.now(),
	set: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		// Node requests/sockets own process liveness. A response abandoned by a
		// local caller must not keep an otherwise idle process alive for 5 minutes.
		if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Request-local absolute deadline. No operation can renew it. `wait` is for
 * cancellable/read-only work, NOT for abandoning durable admission/settlement.
 * Late completion is observed, and callers may dispose of its returned body.
 */
export function createRequestDeadline(
	deadlineAtMs: number,
	parentSignal?: AbortSignal,
	clock: DeadlineClock = CLOCK,
	observeWaitOperation?: (completion: Promise<void>) => void,
) {
	if (!Number.isSafeInteger(deadlineAtMs)) throw new RangeError('Invalid request deadline');
	const controller = new AbortController();
	let timer: unknown;
	let disposed = false;
	let mutationsClosed = false;
	const ownedMutations = new Set<Promise<unknown>>();
	const stop = (reason: RequestExecutionStoppedError['reason']): void => {
		if (!controller.signal.aborted) controller.abort(new RequestExecutionStoppedError(reason));
	};
	const onParentAbort = (): void => stop('client_cancelled');
	const arm = (): void => {
		if (disposed || controller.signal.aborted) return;
		const remaining = deadlineAtMs - clock.now();
		if (remaining <= 0) stop('deadline_exceeded');
		else timer = clock.set(arm, Math.min(remaining, 2_147_483_647));
	};
	const throwIfStopped = (): void => {
		if (!controller.signal.aborted && clock.now() >= deadlineAtMs) stop('deadline_exceeded');
		controller.signal.throwIfAborted();
		if (disposed) throw new Error('Request execution owner has closed');
	};
	const dispose = (): void => {
		disposed = true;
		if (timer !== undefined) clock.clear(timer);
		parentSignal?.removeEventListener('abort', onParentAbort);
	};
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
	arm();

	function runOwnedMutation<T>(operation: () => Promise<T>): Promise<T> {
		throwIfStopped();
		if (mutationsClosed) throw new Error('Request mutation owner has closed');
		const pending = Promise.resolve().then(() => {
			throwIfStopped();
			if (mutationsClosed) throw new Error('Request mutation owner has closed');
			return operation();
		});
		ownedMutations.add(pending);
		// Observe both outcomes; the original caller still receives any failure.
		void pending.then(() => ownedMutations.delete(pending), () => ownedMutations.delete(pending));
		return pending;
	}

	async function drainOwnedMutations(): Promise<void> {
		// Seal before the first await: a sibling preparation that completes after
		// an unrelated failure must not start a write after this drain's snapshot.
		mutationsClosed = true;
		while (ownedMutations.size > 0) await Promise.allSettled([...ownedMutations]);
	}

	async function wait<T>(operation: () => Promise<T>, onLateResult?: (result: T) => void | Promise<void>): Promise<T> {
		throwIfStopped();
		return new Promise<T>((resolve, reject) => {
			// Cancellation ends the caller's wait, not the underlying read/crypto work.
			// Register before invocation; async late-result cleanup belongs to this receipt.
			let complete = () => {};
			let cleanupFailed = (_error: unknown) => {};
			if (observeWaitOperation) {
				const completion = new Promise<void>((yes, no) => { complete = yes; cleanupFailed = no; });
				void completion.catch(() => undefined);
				try { observeWaitOperation(completion); }
				catch (error) { complete(); reject(error); return; }
			}
			let settled = false;
			const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
			const onAbort = (): void => {
				settled = true;
				cleanup();
				reject(controller.signal.reason);
			};
			controller.signal.addEventListener('abort', onAbort, { once: true });
			if (controller.signal.aborted) { onAbort(); complete(); return; }
			// Defer invocation so synchronous throws are observed too. Recheck after
			// the microtask boundary: cancellation must not start new work.
			void Promise.resolve().then(() => { throwIfStopped(); return operation(); }).then(
				async (result) => {
					cleanup();
					if (settled) { await onLateResult?.(result); return; }
					settled = true;
					resolve(result);
				},
				(error: unknown) => { cleanup(); settled = true; reject(error); },
			).then(complete, error => { cleanupFailed(error); reject(error); });
		});
	}

	/** Keep cancellation live after headers, even while downstream is not reading. */
	function wrapResponse(response: Response): Response {
		if (!response.body) { dispose(); return response; }
		const reader = response.body.getReader();
		let terminal = false;
		let streamController: ReadableStreamDefaultController<Uint8Array>;
		const finish = (): void => {
			terminal = true;
			controller.signal.removeEventListener('abort', onAbort);
			dispose();
		};
		const cancelReader = (reason: unknown): void => {
			// Cancellation can itself hang for a tee/custom transport. Do not make
			// the deadline wait for that acknowledgement; always observe rejection.
			void reader.cancel(reason).catch(() => undefined);
			reader.releaseLock();
		};
		const onAbort = (): void => {
			if (terminal) return;
			finish();
			streamController.error(controller.signal.reason);
			cancelReader(controller.signal.reason);
		};
		const body = new ReadableStream<Uint8Array>({
			start(target) {
				streamController = target;
				controller.signal.addEventListener('abort', onAbort, { once: true });
				if (controller.signal.aborted) onAbort();
			},
			async pull(target) {
				if (terminal) return;
				try {
					const chunk = await wait(() => reader.read());
					if (terminal) return;
					if (chunk.done) { finish(); reader.releaseLock(); target.close(); }
					else target.enqueue(chunk.value);
				} catch (error) {
					if (!terminal) { finish(); target.error(error); cancelReader(error); }
				}
			},
			cancel() {
				if (!terminal) {
					finish();
					stop('client_cancelled');
					cancelReader(controller.signal.reason);
				}
			},
		}, { highWaterMark: 0 });
		return new Response(body, response);
	}

	return { deadlineAtMs, signal: controller.signal, throwIfStopped, wait, runOwnedMutation, drainOwnedMutations, wrapResponse, dispose };
}

export type RequestDeadline = ReturnType<typeof createRequestDeadline>;
