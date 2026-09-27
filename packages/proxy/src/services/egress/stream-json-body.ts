import type { JsonStructureLimits } from '../json-structure-budget';
import { isJsonString, jsonStringChunks, JsonStringPages } from './json-string-pages';

export const JSON_OUTPUT_PAGE_BYTES = 64 * 1024;
export const JSON_STRING_PIECE_CHARS = 8 * 1024;

// Native stringify is still the escaping authority when needed. Most image
// data/URLs and decoded replacement/BMP text require no JSON escaping at all.
const NEEDS_JSON_ESCAPING = /["\\\u0000-\u001f\ud800-\udfff]/;

type JsonValue = null | boolean | number | string | JsonStringPages | JsonValue[] | { [key: string]: JsonValue };
type JsonBodyLifecycle = {
	signal?: AbortSignal;
	/** Checks the original absolute deadline even if its timer has not fired. */
	checkActive?: () => void;
	/** Encoding EOF/cancel/error, not an acknowledgement of network delivery. Must not throw. */
	onFinished?: () => void;
};

/** Reject internal non-JSON values BEFORE handing off any response bytes. */
function assertJsonTree(value: unknown, limits: JsonStructureLimits, checkActive?: () => void): asserts value is JsonValue {
	if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1
		|| !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1) throw new RangeError('Invalid JSON encoding limits');
	let nodes = 0;
	const active = new Set<object>();
	const count = () => {
		if (++nodes > limits.maxNodes) throw new RangeError('JSON encoding structure exceeds its limit');
		checkActive?.();
	};
	const visit = (item: unknown, depth: number): void => {
		count();
		if (item === null || isJsonString(item) || typeof item === 'boolean' || typeof item === 'number') return;
		if (typeof item !== 'object' || depth >= limits.maxDepth || active.has(item)) throw new TypeError('Expected a bounded JSON tree');
		if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
			throw new TypeError('Expected a plain JSON object');
		}
		active.add(item);
		const inspectProperty = (key: string): void => {
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor || !('value' in descriptor)) throw new TypeError('JSON accessors and sparse arrays are not supported');
			const child: unknown = descriptor.value;
			visit(child, depth + 1);
		};
		if (Array.isArray(item)) {
			for (let index = 0; index < item.length; index++) inspectProperty(String(index));
		} else {
			for (const key of Object.keys(item)) { count(); inspectProperty(key); }
		}
		active.delete(item);
	};
	visit(value, 0);
}

function* stringPieces(value: string | JsonStringPages): Generator<string, void, unknown> {
	yield '"';
	let highSurrogate = '';
	for (const chunk of jsonStringChunks(value)) {
		for (let start = 0; start < chunk.length;) {
			const end = Math.min(chunk.length, start + JSON_STRING_PIECE_CHARS - highSurrogate.length);
			let piece = highSurrogate + chunk.slice(start, end); start = end;
			highSurrogate = '';
			// Both decoded page boundaries and scalar-piece boundaries may split
			// a valid pair. Carry just the high surrogate, never join whole pages.
			const last = piece.charCodeAt(piece.length - 1);
			if (last >= 0xd800 && last <= 0xdbff) { highSurrogate = piece.slice(-1); piece = piece.slice(0, -1); }
			if (piece) yield NEEDS_JSON_ESCAPING.test(piece) ? JSON.stringify(piece).slice(1, -1) : piece;
		}
	}
	if (highSurrogate) yield JSON.stringify(highSurrogate).slice(1, -1);
	yield '"';
}

function* valuePieces(value: JsonValue): Generator<string, void, unknown> {
	if (isJsonString(value)) { yield* stringPieces(value); return; }
	if (value === null || typeof value !== 'object') { yield JSON.stringify(value); return; }
	if (Array.isArray(value)) {
		yield '[';
		for (let index = 0; index < value.length; index++) {
			if (index) yield ',';
			yield* valuePieces(value[index]!);
		}
		yield ']';
	} else {
		yield '{';
		let first = true;
		// Object.keys uses the same own enumerable string-key order as native
		// stringify, including integer-index keys and parsed __proto__ properties.
		for (const key of Object.keys(value)) {
			if (!first) yield ',';
			first = false;
			yield* stringPieces(key);
			yield ':';
			yield* valuePieces(value[key]!);
		}
		yield '}';
	}
}

/**
 * Count JSON-escaped UTF-8 bytes directly from decoded UTF-16 units. This does
 * not construct escaped text or encode every string a second time at preflight.
 * Carry one high surrogate across pages (including empty pages); lone surrogate
 * units use native well-formed JSON's six ASCII bytes, not UTF-8 replacement.
 */
function stringByteLength(value: string | JsonStringPages, checkActive?: () => void): number {
	let length = 2, highSurrogate = false; // Opening and closing quotes.
	for (const chunk of jsonStringChunks(value)) {
		for (let index = 0; index < chunk.length; index++) {
			if (index % JSON_STRING_PIECE_CHARS === 0) checkActive?.();
			const code = chunk.charCodeAt(index);
			if (highSurrogate) {
				highSurrogate = false;
				if (code >= 0xdc00 && code <= 0xdfff) { length += 4; continue; }
				length += 6;
			}
			if (code >= 0xd800 && code <= 0xdbff) highSurrogate = true;
			else if (code >= 0xdc00 && code <= 0xdfff) length += 6;
			else if (code < 32) length += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
			else if (code === 34 || code === 92) length += 2;
			else length += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
		}
	}
	return length + (highSurrogate ? 6 : 0);
}

/** Exact native JSON UTF-8 wire length, without serializing/encoding string values or keys. */
export function jsonBodyByteLength(value: unknown, limits: JsonStructureLimits, checkActive?: () => void): number {
	assertJsonTree(value, limits, checkActive);
	let length = 0;
	const add = (bytes: number): void => {
		length += bytes;
		if (!Number.isSafeInteger(length)) throw new RangeError('JSON wire length exceeds the safe integer range');
	};
	const count = (item: JsonValue): void => {
		checkActive?.();
		if (isJsonString(item)) { add(stringByteLength(item, checkActive)); return; }
		// Native number formatting includes -0, exponent form and non-finite -> null.
		if (item === null || typeof item !== 'object') { add(JSON.stringify(item).length); return; }
		if (Array.isArray(item)) {
			add(2 + Math.max(0, item.length - 1));
			for (let index = 0; index < item.length; index++) count(item[index]!);
		} else {
			const keys = Object.keys(item);
			add(2 + Math.max(0, keys.length - 1));
			for (const key of keys) { add(stringByteLength(key, checkActive) + 1); count(item[key]!); }
		}
	};
	count(value);
	return length;
}

/**
 * Explicit legacy boundary: one complete JSON string is still required by
 * raw_usage storage. Reuse the encoder's bounded escaped pieces, without first
 * materializing every string in a duplicate native tree or allocating UTF-8
 * buffers. Callers must admit the source and account for this complete result.
 * Keep native pages at this boundary: collecting decoded compact pages would
 * temporarily retain both representations. Not for ordinary response delivery.
 */
export function materializeJsonBodyText(value: unknown, limits: JsonStructureLimits, checkActive?: () => void): string {
	assertJsonTree(value, limits, checkActive);
	const parts: string[] = [];
	for (const piece of valuePieces(value)) { checkActive?.(); if (piece) parts.push(piece); }
	checkActive?.();
	const text = parts.join('');
	checkActive?.();
	return text;
}

/**
 * Encode an already parsed/validated, request-owned JSON tree on demand.
 * Not a general replacement for JSON.stringify: no getters, toJSON,
 * arbitrary class instances, undefined, sparse arrays or cycles. JsonStringPages
 * is the sole internal scalar exception. The owner must not mutate
 * the tree after handoff. Native scalar escaping/number semantics are preserved.
 *
 * Holds the source tree until completion/cancel. Encoding itself keeps only one
 * <=64 KiB byte page and a bounded escaped string piece, never a whole JSON string
 * or complete encoded byte array. Whole input parsing/aggregate memory is separate.
 */
export function streamJsonBody(value: unknown, limits: JsonStructureLimits, lifecycle: JsonBodyLifecycle = {}): ReadableStream<Uint8Array> {
	lifecycle.signal?.throwIfAborted();
	lifecycle.checkActive?.();
	assertJsonTree(value, limits, lifecycle.checkActive);
	let iterator: Generator<string, void, unknown> | undefined = valuePieces(value);
	value = undefined; // Only the disposable iterator owns the caller's tree now.
	let pending = '';
	let closed = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const finish = (): void => {
		if (closed) return;
		closed = true;
		lifecycle.signal?.removeEventListener('abort', onAbort);
		iterator?.return();
		iterator = undefined;
		pending = '';
		const onFinished = lifecycle.onFinished;
		lifecycle = {};
		onFinished?.();
	};
	const fail = (): void => {
		if (closed) return;
		finish();
		// Never reflect client abort reasons or a late internal object value.
		controller.error(new Error('JSON response delivery was interrupted'));
	};
	const onAbort = (): void => fail();
	return new ReadableStream<Uint8Array>({
		start(target) {
			controller = target;
			lifecycle.signal?.addEventListener('abort', onAbort, { once: true });
			if (lifecycle.signal?.aborted) onAbort();
		},
		pull(target) {
			if (closed) return;
			try {
				lifecycle.checkActive?.();
				lifecycle.signal?.throwIfAborted();
				if (closed) return;
				const page = new Uint8Array(JSON_OUTPUT_PAGE_BYTES);
				let used = 0;
				while (used < page.length) {
					if (!pending) {
						const next = iterator!.next();
						if (next.done) { finish(); break; }
						pending = next.value;
						if (!pending) continue;
					}
					const { read, written } = encoder.encodeInto(pending, page.subarray(used));
					if (read === 0) break; // A final 1-3 bytes may not fit the next UTF-8 character.
					used += written;
					pending = pending.slice(read);
				}
				if (used) target.enqueue(used === page.length ? page : page.subarray(0, used));
				if (closed) target.close();
			} catch { fail(); }
		},
		cancel() { finish(); },
	}, { highWaterMark: 0 });
}

/** A rejected Response constructor must not leave an unread encoder/deadline owned. */
export function streamJsonResponse(value: unknown, limits: JsonStructureLimits, init: ResponseInit, lifecycle: JsonBodyLifecycle = {}): Response {
	const body = streamJsonBody(value, limits, lifecycle);
	try { return new Response(body, init); }
	catch (error) { void body.cancel().catch(() => undefined); throw error; }
}
