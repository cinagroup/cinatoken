export const JSON_TEXT_PAGE_CHARS = 64 * 1024;
export type JsonStringPage = string | CompactJsonStringPage;

/**
 * Private in-memory encoding, NOT UTF-8 and never a wire/storage/RPC format.
 * UTF-8-shaped bytes preserve lone UTF-16 surrogates; unused lead byte FF stores
 * U+FFFD in one byte, avoiding replacement-decoding's two-byte retained text.
 * Only validated decoded, bounded strings enter here. No byte import/export API.
 * Native Latin-1 and pages without a useful saving stay native; this is not a
 * total-instance memory bound. Decoding is temporary and never cached.
 */
export class CompactJsonStringPage {
	readonly #bytes: Uint8Array;
	readonly #length: number;
	private constructor(text: string, byteLength: number) {
		this.#length = text.length;
		this.#bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (let i = 0; i < text.length; i++) {
			let code = text.charCodeAt(i);
			if (code < 0x80) this.#bytes[offset++] = code;
			else if (code === 0xfffd) this.#bytes[offset++] = 0xff;
			else if (code < 0x800) {
				this.#bytes[offset++] = 0xc0 | (code >> 6); this.#bytes[offset++] = 0x80 | (code & 63);
			} else {
				const low = text.charCodeAt(i + 1);
				if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; i++;
					this.#bytes[offset++] = 0xf0 | (code >> 18);
					this.#bytes[offset++] = 0x80 | ((code >> 12) & 63);
				} else this.#bytes[offset++] = 0xe0 | (code >> 12);
				this.#bytes[offset++] = 0x80 | ((code >> 6) & 63); this.#bytes[offset++] = 0x80 | (code & 63);
			}
		}
		Object.freeze(this);
	}
	static from(text: string): JsonStringPage {
		if (typeof text !== 'string' || text.length > JSON_TEXT_PAGE_CHARS) throw new RangeError('Invalid JSON string page');
		// Avoid objects/buffers for short tails and native one-byte alphabets.
		if (text.length < 1024 || !/[^\u0000-\u00ff]/.test(text)) return text;
		let bytes = 0;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i), low = text.charCodeAt(i + 1);
			if (code < 0x80 || code === 0xfffd) bytes++;
			else if (code < 0x800) bytes += 2;
			else if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) { bytes += 4; i++; }
			else bytes += 3;
		}
		// Leave a margin for per-page object overhead; do not expand BMP/emoji text.
		return bytes + 64 < text.length * 2 ? new CompactJsonStringPage(text, bytes) : text;
	}
	get length(): number { return this.#length; }
	get byteLength(): number { return this.#bytes.length; }
	decode(): string {
		const units = new Uint16Array(this.#length), bytes = this.#bytes;
		let offset = 0;
		for (let i = 0; i < bytes.length;) {
			const lead = bytes[i++]!;
			if (lead < 0x80) units[offset++] = lead;
			else if (lead === 0xff) units[offset++] = 0xfffd;
			else if (lead < 0xe0) units[offset++] = ((lead & 31) << 6) | (bytes[i++]! & 63);
			else if (lead < 0xf0) units[offset++] = ((lead & 15) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
			else {
				const point = (((lead & 7) << 18) | ((bytes[i++]! & 63) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63)) - 0x10000;
				units[offset++] = 0xd800 | (point >> 10); units[offset++] = 0xdc00 | (point & 1023);
			}
		}
		const pieces: string[] = [];
		for (let i = 0; i < units.length; i += 4096) pieces.push(String.fromCharCode(...units.subarray(i, i + 4096)));
		return pieces.join('');
	}
	toJSON(): never { throw new TypeError('Compact JSON pages are internal only'); }
	[Symbol.toPrimitive](): never { throw new TypeError('Compact JSON pages require explicit decoding'); }
}

export const decodeJsonStringPage = (page: JsonStringPage): string => typeof page === 'string' ? page : page.decode();
