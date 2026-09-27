import { CompactJsonStringPage, decodeJsonStringPage, JSON_TEXT_PAGE_CHARS, type JsonStringPage } from './compact-json-string-page';
export { JSON_TEXT_PAGE_CHARS } from './compact-json-string-page';

/** Internal, request-owned JSON text. Never cross a storage/RPC boundary. */

export class JsonStringPages {
	readonly #pages: readonly JsonStringPage[];
	readonly #length: number;
	constructor(pages: readonly JsonStringPage[]) {
		for (const page of pages) {
			if ((typeof page !== 'string' && !(page instanceof CompactJsonStringPage)) || page.length > JSON_TEXT_PAGE_CHARS) throw new RangeError('Invalid JSON string page');
		}
		this.#pages = Object.freeze([...pages]);
		this.#length = pages.reduce((length, page) => length + page.length, 0);
		Object.freeze(this);
	}
	get length(): number { return this.#length; }
	*chunks(): Generator<string, void, unknown> { for (const page of this.#pages) yield decodeJsonStringPage(page); }
	/** Explicit legacy boundary only. Do not retain the full copy in this object. */
	materialize(): string { return [...this.chunks()].join(''); }
	/** Decode only trim boundaries; share all immutable interior storage pages. */
	trim(checkActive?: () => void): string | JsonStringPages {
		checkActive?.();
		let first = 0, last = this.#pages.length - 1, start = '', end = '', changed = false;
		while (first <= last) {
			checkActive?.();
			const page = decodeJsonStringPage(this.#pages[first]!); start = page.trimStart();
			if (start) { changed ||= start.length !== page.length; break; }
			changed = true; first++;
		}
		if (first > last) return '';
		while (last >= first) {
			checkActive?.();
			const page = last === first ? start : decodeJsonStringPage(this.#pages[last]!); end = page.trimEnd();
			if (end) { changed ||= end.length !== page.length; break; }
			changed = true; last--;
		}
		if (!changed) return this;
		return new JsonStringPages(first === last ? [end] : [start, ...this.#pages.slice(first + 1, last), end]);
	}
	toJSON(): never { throw new TypeError('Paged JSON strings require the streaming encoder'); }
	[Symbol.toPrimitive](): never { throw new TypeError('Paged JSON strings require explicit materialization'); }
}

export function isJsonString(value: unknown): value is string | JsonStringPages {
	return typeof value === 'string' || value instanceof JsonStringPages;
}

export function* jsonStringChunks(value: string | JsonStringPages): Generator<string, void, unknown> {
	if (value instanceof JsonStringPages) { yield* value.chunks(); return; }
	for (let start = 0; start < value.length; start += JSON_TEXT_PAGE_CHARS) {
		yield value.slice(start, start + JSON_TEXT_PAGE_CHARS);
	}
}

export function hasJsonStringContent(value: unknown): boolean {
	if (!isJsonString(value)) return false;
	for (const chunk of jsonStringChunks(value)) if (/\S/.test(chunk)) return true;
	return false;
}

/** Native trim semantics without joining a paged image/data URL. Shares immutable pages. */
export function trimJsonString(value: string | JsonStringPages): string | JsonStringPages {
	return value.trim();
}

/**
 * For an already validated JSON tree at a legacy boundary that needs native
 * strings. Images raw_usage now serializes directly from pages instead. Not for
 * the response payload or a way to bypass a caller's memory admission.
 * Retains JSON property order and special keys without invoking prototype setters.
 */
export function materializeJsonStringTree(value: unknown): unknown {
	if (value instanceof JsonStringPages) return value.materialize();
	if (Array.isArray(value)) return value.map(materializeJsonStringTree);
	if (value === null || typeof value !== 'object') return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) Object.defineProperty(result, key, {
		value: materializeJsonStringTree(child), enumerable: true, writable: true, configurable: true,
	});
	return result;
}
