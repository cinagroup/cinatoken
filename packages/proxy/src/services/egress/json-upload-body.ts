import { createHash } from 'node:crypto';
import { jsonBodyByteLength, streamJsonBody } from './stream-json-body';
import { JsonStringPages } from './json-string-pages';

// Admission belongs to the public parser, not serialization. Route defaults can
// add nodes/depth to an admitted request; do not silently reuse a response/input
// ceiling and reject previously valid merged bodies. Config/default and whole-
// instance capacity admission are separate, still-required gates.
const ENCODING_LIMITS = Object.freeze({ maxDepth: Number.MAX_SAFE_INTEGER, maxNodes: Number.MAX_SAFE_INTEGER });

/**
 * Snapshot JSON.stringify's value projection before durable dispatch admission.
 * Strings are immutable and shared, containers are copied. Internal callers may
 * supply optional values or typed arrays. Getters/toJSON, if present, run here
 * once, never during later network pulls. Public request/config values are JSON.
 */
function snapshotJson(value: unknown, checkActive: () => void, active = new Set<object>(), key = ''): unknown {
	checkActive();
	// Internal immutable scalar, not a user object with a toJSON hook.
	if (value instanceof JsonStringPages) return value;
	if ((value !== null && typeof value === 'object') || typeof value === 'bigint') {
		const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') value = Reflect.apply(toJSON, value, [key]);
	}
	if (value instanceof Number) value = Number(value);
	else if (value instanceof String) value = String(value);
	else if (value instanceof Boolean) value = Boolean.prototype.valueOf.call(value);
	else if (value instanceof BigInt) throw new TypeError('JSON request bigint is not supported');
	if (typeof value === 'function' || typeof value === 'symbol') return undefined;
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || value === undefined) return value;
	if (typeof value !== 'object' || active.has(value)) throw new TypeError('Expected a JSON request without cycles or bigint');
	active.add(value);
	const source = value as Record<string, unknown>;
	const property = (name: string) => snapshotJson(source[name], checkActive, active, name);
	let result: unknown;
	if (Array.isArray(value)) {
		const array: unknown[] = [];
		const length = value.length;
		for (let index = 0; index < length; index++) array.push(property(String(index)) ?? null);
		result = array;
	} else {
		const object: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			const child = property(key);
			if (child !== undefined) Object.defineProperty(object, key, { value: child, enumerable: true, configurable: true, writable: true });
		}
		result = object;
	}
	active.delete(value);
	return Object.freeze(result);
}

/** Request-owned encoder. dispose also stops a transport-locked, unread body. */
export function createJsonUploadBody(value: Record<string, unknown>, signal: AbortSignal, checkActive: () => void) {
	const assertActive = () => { signal.throwIfAborted(); checkActive(); };
	const snapshot = snapshotJson(value, assertActive);
	const contentLength = jsonBodyByteLength(snapshot, ENCODING_LIMITS, assertActive);
	const owner = new AbortController();
	const onAbort = () => { owner.abort(); };
	const onFinished = () => { signal.removeEventListener('abort', onAbort); };
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		assertActive();
		const body = streamJsonBody(snapshot, ENCODING_LIMITS, { signal: owner.signal, checkActive: assertActive, onFinished });
		const digestSha256 = async (): Promise<string> => {
			// Replay the same immutable projection through the same encoder. Digesting
			// the transport stream would consume it before fetch; stringify would
			// materialize a second whole request, including paged JSON strings.
			const hash = createHash('sha256');
			const digestBody = streamJsonBody(snapshot, ENCODING_LIMITS, {
				signal,
				checkActive: assertActive,
			});
			const reader = digestBody.getReader();
			let bytes = 0;
			try {
				while (true) {
					assertActive();
					const part = await reader.read();
					assertActive();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > contentLength) throw new Error('JSON upload digest length mismatch');
					hash.update(part.value);
				}
				if (bytes !== contentLength) throw new Error('JSON upload digest length mismatch');
				return hash.digest('hex');
			} finally {
				void reader.cancel('json_upload_digest_finished').catch(() => undefined);
				reader.releaseLock();
			}
		};
		// The Images grant digest consumes this exact private projection. The
		// caller must never expose or mutate it; the upload stream owns it too.
		return { body, contentLength, preparedSnapshot: snapshot, digestSha256,
			dispose: () => { onFinished(); owner.abort(); } };
	} catch (error) { onFinished(); throw error; }
}
