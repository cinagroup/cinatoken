/**
 * Request-local preparation contract, independent of the HTTP runtime.
 * `wait` may stop waiting for reads or preparation whose EVERY write is
 * registered on this same control; it does not cancel SQL/Web Crypto.
 * Compatibility writes MUST use runOwnedMutation. The owner must drain those
 * mutations before ending the request, including when an outer wait aborts.
 */
export interface PreparationControl {
	readonly signal: AbortSignal;
	throwIfStopped(): void;
	wait<T>(operation: () => Promise<T>, onLateResult?: (result: T) => void): Promise<T>;
	runOwnedMutation<T>(operation: () => Promise<T>): Promise<T>;
}

export async function preparationRead<T>(
	control: PreparationControl | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	control?.throwIfStopped();
	const result = await (control ? control.wait(operation) : operation());
	control?.throwIfStopped();
	return result;
}

export async function preparationMutation<T>(
	control: PreparationControl | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	control?.throwIfStopped();
	// Never race an already-started write against cancellation.
	const result = await (control ? control.runOwnedMutation(operation) : operation());
	control?.throwIfStopped();
	return result;
}
