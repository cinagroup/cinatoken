const TRANSIENT_POSTGRES_CONNECTION_CODES = new Set([
	'CONNECTION_CLOSED',
	'CONNECTION_DESTROYED',
	'CONNECTION_ENDED',
]);

/** Classifies connection loss only; never permission, SQL or constraint errors. */
export function isTransientPostgresConnectionError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (typeof current !== 'object') return false;
		const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (
			typeof candidate.code === 'string' &&
			TRANSIENT_POSTGRES_CONNECTION_CODES.has(candidate.code.toUpperCase())
		) return true;
		if (
			typeof candidate.message === 'string' &&
			/\bCONNECTION_(?:CLOSED|DESTROYED|ENDED)\b/u.test(candidate.message.toUpperCase())
		) return true;
		current = candidate.cause;
	}
	return false;
}
