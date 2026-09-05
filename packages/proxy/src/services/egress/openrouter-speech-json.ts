/**
 * Bounded OpenRouter TTS JSON reader.
 *
 * A voice-cloning reference can carry 20 MiB of base64. Decode that field
 * while the request stream is read and retain only the smaller binary payload
 * plus a bounded metadata document. This keeps a Worker below its isolate
 * memory ceiling during routing and Guardrail evaluation.
 */

export const OPENROUTER_SPEECH_REFERENCE_MAX_BASE64_BYTES = 20 * 1024 * 1024;
export const OPENROUTER_SPEECH_REFERENCE_MAX_DECODED_BYTES = 15 * 1024 * 1024;
export const OPENROUTER_SPEECH_JSON_MAX_METADATA_BYTES = 256 * 1024;
export const OPENROUTER_SPEECH_JSON_MAX_REQUEST_BYTES =
	OPENROUTER_SPEECH_REFERENCE_MAX_BASE64_BYTES
	+ OPENROUTER_SPEECH_JSON_MAX_METADATA_BYTES;

export const OPENROUTER_SPEECH_AUDIO_SENTINEL = '__cinatoken_openrouter_speech_audio__';

const BASE64_FLUSH_CHARS = 64 * 1024;
const DATA_URI_PREFIX_MAX_CHARS = 128;

export type OpenRouterSpeechJsonFailureKind =
	| 'invalid_json'
	| 'invalid_request'
	| 'payload_too_large'
	| 'cancelled';

export class OpenRouterSpeechJsonError extends Error {
	constructor(
		readonly kind: OpenRouterSpeechJsonFailureKind,
		message: string,
	) {
		super(message);
		this.name = 'OpenRouterSpeechJsonError';
	}
}

export type OpenRouterSpeechReferenceEncoding =
	| { kind: 'raw_base64' }
	| { kind: 'data_uri'; mediaType: string };

export type OpenRouterSpeechJsonResult = {
	body: Record<string, unknown>;
	referenceAudio: {
		bytes: Uint8Array;
		encoding: OpenRouterSpeechReferenceEncoding;
	} | null;
};

export type OpenRouterSpeechJsonLimits = {
	maxBase64Bytes?: number;
	maxDecodedBytes?: number;
	maxMetadataBytes?: number;
	maxRequestBytes?: number;
};

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
		? Math.min(value, fallback)
		: fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

class BoundedBase64Decoder {
	private pending = '';
	private encodedChars = 0;
	private output = new Uint8Array(64 * 1024);
	private outputLength = 0;
	private paddingStarted = false;
	private paddingChars = 0;

	constructor(
		private readonly maxEncodedChars: number,
		private readonly maxDecodedBytes: number,
	) {}

	push(value: string): void {
		if (!value) return;
		this.encodedChars += value.length;
		if (this.encodedChars > this.maxEncodedChars) {
			throw new OpenRouterSpeechJsonError(
				'invalid_request',
				`input_references audio base64 must be at most ${this.maxEncodedChars} bytes`,
			);
		}

		if (this.paddingStarted) {
			if (!/^=+$/.test(value)) this.invalid();
			this.paddingChars += value.length;
			if (this.paddingChars > 2) this.invalid();
			this.pending += value;
			return;
		}

		const paddingIndex = value.indexOf('=');
		const unpadded = paddingIndex < 0 ? value : value.slice(0, paddingIndex);
		if (unpadded && !/^[A-Za-z0-9+/]+$/.test(unpadded)) this.invalid();
		this.pending += unpadded;
		if (paddingIndex >= 0) {
			const padding = value.slice(paddingIndex);
			if (!/^=+$/.test(padding) || padding.length > 2) this.invalid();
			this.paddingStarted = true;
			this.paddingChars = padding.length;
			this.pending += padding;
			return;
		}

		if (this.pending.length >= BASE64_FLUSH_CHARS) {
			const flushLength = this.pending.length - (this.pending.length % 4);
			if (flushLength > 0) {
				this.decodeQuartets(this.pending.slice(0, flushLength));
				this.pending = this.pending.slice(flushLength);
			}
		}
	}

	finish(): Uint8Array {
		if (this.encodedChars === 0) {
			throw new OpenRouterSpeechJsonError(
				'invalid_request',
				'input_references audio data must not be empty',
			);
		}
		if (this.paddingStarted) {
			if (this.pending.length % 4 !== 0) this.invalid();
		} else {
			const remainder = this.pending.length % 4;
			if (remainder === 1) this.invalid();
			if (remainder > 0) this.pending += '='.repeat(4 - remainder);
		}
		this.decodeQuartets(this.pending);
		this.pending = '';
		return this.output.subarray(0, this.outputLength);
	}

	private invalid(): never {
		throw new OpenRouterSpeechJsonError(
			'invalid_request',
			'input_references audio data is not valid base64',
		);
	}

	private decodeQuartets(value: string): void {
		if (!value) return;
		let binary: string;
		try {
			binary = atob(value);
		} catch {
			this.invalid();
		}
		const required = this.outputLength + binary.length;
		if (required > this.maxDecodedBytes) {
			throw new OpenRouterSpeechJsonError(
				'invalid_request',
				`input_references audio decodes to more than ${this.maxDecodedBytes} bytes`,
			);
		}
		this.ensureCapacity(required);
		for (let index = 0; index < binary.length; index += 1) {
			this.output[this.outputLength + index] = binary.charCodeAt(index);
		}
		this.outputLength = required;
	}

	private ensureCapacity(required: number): void {
		if (required <= this.output.byteLength) return;
		let nextLength = this.output.byteLength;
		while (nextLength < required) {
			nextLength = Math.min(this.maxDecodedBytes, nextLength * 2);
			if (nextLength < required && nextLength === this.maxDecodedBytes) {
				throw new OpenRouterSpeechJsonError(
					'invalid_request',
					'input_references audio data is too large',
				);
			}
		}
		const next = new Uint8Array(nextLength);
		next.set(this.output.subarray(0, this.outputLength));
		this.output = next;
	}
}

class ReferenceAudioDecoder {
	private prefix = '';
	private mode: 'pending' | 'raw_base64' | 'data_uri' = 'pending';
	private mediaType: string | null = null;

	constructor(private readonly base64: BoundedBase64Decoder) {}

	push(value: string): void {
		if (!value) return;
		if (this.mode !== 'pending') {
			this.base64.push(value);
			return;
		}
		this.prefix += value;
		if ('data:'.startsWith(this.prefix)) return;
		if (!this.prefix.startsWith('data:')) {
			this.mode = 'raw_base64';
			this.base64.push(this.prefix);
			this.prefix = '';
			return;
		}
		const commaIndex = this.prefix.indexOf(',');
		if (commaIndex < 0) {
			if (this.prefix.length > DATA_URI_PREFIX_MAX_CHARS) this.invalidDataUri();
			return;
		}
		const header = this.prefix.slice(0, commaIndex + 1);
		const match = /^data:(audio\/[A-Za-z0-9.+-]{1,64});base64,$/i.exec(header);
		if (!match) this.invalidDataUri();
		this.mode = 'data_uri';
		this.mediaType = match[1]!.toLowerCase();
		this.base64.push(this.prefix.slice(commaIndex + 1));
		this.prefix = '';
	}

	finish(): { bytes: Uint8Array; encoding: OpenRouterSpeechReferenceEncoding } {
		if (this.mode === 'pending') {
			if (this.prefix.startsWith('data:')) this.invalidDataUri();
			this.mode = 'raw_base64';
			this.base64.push(this.prefix);
			this.prefix = '';
		}
		return {
			bytes: this.base64.finish(),
			encoding: this.mode === 'data_uri'
				? { kind: 'data_uri', mediaType: this.mediaType! }
				: { kind: 'raw_base64' },
		};
	}

	private invalidDataUri(): never {
		throw new OpenRouterSpeechJsonError(
			'invalid_request',
			'input_references audio data URI must use data:audio/<format>;base64,...',
		);
	}
}

type ObjectFrame = {
	kind: 'object';
	path: string[];
	state: 'key_or_end' | 'colon' | 'value' | 'comma_or_end';
	key: string | null;
};

type ArrayFrame = {
	kind: 'array';
	path: string[];
	state: 'value_or_end' | 'comma_or_end';
};

type JsonFrame = ObjectFrame | ArrayFrame;
type StringRole = 'key' | 'value' | 'reference_audio';

class StreamingSpeechJsonExtractor {
	private readonly frames: JsonFrame[] = [];
	private readonly sanitizedParts: string[] = [];
	private sanitizedUtf8Bytes = 0;
	private pendingHighSurrogate = false;
	private rootState: 'value' | 'done' = 'value';
	private inString = false;
	private stringRole: StringRole = 'value';
	private stringEscaped = false;
	private keyRaw = '';
	private inPrimitive = false;
	private audioDataCount = 0;

	constructor(
		private readonly referenceAudio: ReferenceAudioDecoder,
		private readonly maxMetadataBytes: number,
	) {}

	push(text: string): void {
		let index = 0;
		while (index < text.length) {
			if (this.inString) {
				if (this.stringRole === 'reference_audio') {
					const quoteIndex = text.indexOf('"', index);
					const escapeIndex = text.indexOf('\\', index);
					const nextSpecial = quoteIndex < 0
						? escapeIndex
						: escapeIndex < 0
							? quoteIndex
							: Math.min(quoteIndex, escapeIndex);
					const end = nextSpecial < 0 ? text.length : nextSpecial;
					this.referenceAudio.push(text.slice(index, end));
					index = end;
					if (index >= text.length) break;
					if (text[index] === '\\') {
						throw new OpenRouterSpeechJsonError(
							'invalid_request',
							'input_references audio data must not contain JSON escapes',
						);
					}
					this.inString = false;
					this.completeValue();
					index += 1;
					continue;
				}

				const character = text[index]!;
				this.appendSanitized(character);
				if (this.stringRole === 'key') this.keyRaw += character;
				if (this.stringEscaped) {
					this.stringEscaped = false;
				} else if (character === '\\') {
					this.stringEscaped = true;
				} else if (character === '"') {
					this.inString = false;
					if (this.stringRole === 'key') this.completeKey();
					else this.completeValue();
				}
				index += 1;
				continue;
			}

			const character = text[index]!;
			if (this.inPrimitive) {
				if (character !== ',' && character !== '}' && character !== ']') {
					this.appendSanitized(character);
					index += 1;
					continue;
				}
				this.inPrimitive = false;
				this.completeValue();
				continue;
			}

			if (/\s/.test(character)) {
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === '"') {
				this.beginString();
				index += 1;
				continue;
			}
			if (character === '{' || character === '[') {
				this.beginContainer(character);
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === '}' || character === ']') {
				this.endContainer(character);
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === ':') {
				const frame = this.frames[this.frames.length - 1];
				if (frame?.kind === 'object' && frame.state === 'colon') frame.state = 'value';
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === ',') {
				const frame = this.frames[this.frames.length - 1];
				if (frame?.kind === 'object' && frame.state === 'comma_or_end') {
					frame.state = 'key_or_end';
					frame.key = null;
				} else if (frame?.kind === 'array' && frame.state === 'comma_or_end') {
					frame.state = 'value_or_end';
				}
				this.appendSanitized(character);
				index += 1;
				continue;
			}

			this.inPrimitive = true;
			this.appendSanitized(character);
			index += 1;
		}
	}

	finish(): OpenRouterSpeechJsonResult {
		if (this.inString || this.inPrimitive || this.frames.length !== 0 || this.rootState !== 'done') {
			throw new OpenRouterSpeechJsonError('invalid_json', 'Invalid JSON body');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.sanitizedParts.join('')) as unknown;
		} catch {
			throw new OpenRouterSpeechJsonError('invalid_json', 'Invalid JSON body');
		}
		if (!isRecord(parsed)) {
			throw new OpenRouterSpeechJsonError('invalid_request', 'JSON body must be an object');
		}
		return {
			body: parsed,
			referenceAudio: this.audioDataCount === 1 ? this.referenceAudio.finish() : null,
		};
	}

	private beginString(): void {
		const frame = this.frames[this.frames.length - 1];
		if (frame?.kind === 'object' && frame.state === 'key_or_end') {
			this.stringRole = 'key';
			this.keyRaw = '"';
			this.appendSanitized('"');
		} else {
			const path = this.valuePath();
			const referenceAudio = path.length === 4
				&& path[0] === 'input_references'
				&& path[1] === '[]'
				&& path[2] === 'input_audio'
				&& path[3] === 'data';
			this.stringRole = referenceAudio ? 'reference_audio' : 'value';
			if (referenceAudio) {
				this.audioDataCount += 1;
				if (this.audioDataCount > 1) {
					throw new OpenRouterSpeechJsonError(
						'invalid_request',
						'input_references must contain at most one input_audio part',
					);
				}
				this.appendSanitized(JSON.stringify(OPENROUTER_SPEECH_AUDIO_SENTINEL));
			} else {
				this.appendSanitized('"');
			}
		}
		this.inString = true;
		this.stringEscaped = false;
	}

	private completeKey(): void {
		const frame = this.frames[this.frames.length - 1];
		if (frame?.kind !== 'object') return;
		let key: unknown;
		try {
			key = JSON.parse(this.keyRaw) as unknown;
		} catch {
			throw new OpenRouterSpeechJsonError('invalid_json', 'Invalid JSON body');
		}
		frame.key = typeof key === 'string' ? key : null;
		frame.state = 'colon';
		this.keyRaw = '';
	}

	private beginContainer(character: '{' | '['): void {
		const path = this.valuePath();
		this.frames.push(character === '{'
			? { kind: 'object', path, state: 'key_or_end', key: null }
			: { kind: 'array', path, state: 'value_or_end' });
	}

	private endContainer(character: '}' | ']'): void {
		const frame = this.frames.pop();
		if (!frame || (character === '}' ? frame.kind !== 'object' : frame.kind !== 'array')) {
			throw new OpenRouterSpeechJsonError('invalid_json', 'Invalid JSON body');
		}
		this.completeValue();
	}

	private valuePath(): string[] {
		const frame = this.frames[this.frames.length - 1];
		if (!frame) return [];
		if (frame.kind === 'object') {
			return frame.key == null ? [...frame.path] : [...frame.path, frame.key];
		}
		return [...frame.path, '[]'];
	}

	private completeValue(): void {
		const frame = this.frames[this.frames.length - 1];
		if (!frame) {
			this.rootState = 'done';
			return;
		}
		frame.state = 'comma_or_end';
	}

	private appendSanitized(value: string): void {
		let index = 0;
		if (this.pendingHighSurrogate) {
			const first = value.charCodeAt(0);
			if (first >= 0xdc00 && first <= 0xdfff) {
				this.sanitizedUtf8Bytes += 4;
				index = 1;
			} else {
				this.sanitizedUtf8Bytes += 3;
			}
			this.pendingHighSurrogate = false;
		}
		while (index < value.length) {
			const codeUnit = value.charCodeAt(index);
			if (codeUnit <= 0x7f) {
				this.sanitizedUtf8Bytes += 1;
			} else if (codeUnit <= 0x7ff) {
				this.sanitizedUtf8Bytes += 2;
			} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					this.sanitizedUtf8Bytes += 4;
					index += 1;
				} else if (index + 1 === value.length) {
					this.pendingHighSurrogate = true;
				} else {
					this.sanitizedUtf8Bytes += 3;
				}
			} else {
				this.sanitizedUtf8Bytes += 3;
			}
			index += 1;
		}
		if (this.sanitizedUtf8Bytes > this.maxMetadataBytes) {
			throw new OpenRouterSpeechJsonError(
				'payload_too_large',
				`Audio speech JSON metadata must be at most ${this.maxMetadataBytes} bytes`,
			);
		}
		this.sanitizedParts.push(value);
	}
}

function decodeUtf8Chunk(decoder: TextDecoder, value?: Uint8Array, stream = false): string {
	try {
		return value === undefined
			? decoder.decode()
			: decoder.decode(value, { stream });
	} catch {
		throw new OpenRouterSpeechJsonError('invalid_json', 'JSON body must be valid UTF-8');
	}
}

function parseDeclaredContentLength(request: Request): number | null {
	const raw = request.headers.get('content-length');
	if (raw == null || raw.trim() === '') return null;
	if (!/^\d+$/.test(raw.trim())) {
		throw new OpenRouterSpeechJsonError('invalid_request', 'Invalid Content-Length header');
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new OpenRouterSpeechJsonError('invalid_request', 'Invalid Content-Length header');
	}
	return value;
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) {
		throw new OpenRouterSpeechJsonError('cancelled', 'Audio speech request was cancelled');
	}
	return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const onAbort = () => {
			cleanup();
			reject(new OpenRouterSpeechJsonError('cancelled', 'Audio speech request was cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		reader.read().then(
			(result) => {
				cleanup();
				resolve(result);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Parse a bounded TTS JSON object while streaming a possible clone sample. */
export async function parseOpenRouterSpeechJson(
	request: Request,
	limits: OpenRouterSpeechJsonLimits = {},
): Promise<OpenRouterSpeechJsonResult> {
	const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (mediaType !== 'application/json') {
		throw new OpenRouterSpeechJsonError(
			'invalid_request',
			'Audio speech JSON body must use Content-Type: application/json',
		);
	}
	const maxBase64Bytes = boundedPositiveInteger(
		limits.maxBase64Bytes,
		OPENROUTER_SPEECH_REFERENCE_MAX_BASE64_BYTES,
	);
	const maxDecodedBytes = boundedPositiveInteger(
		limits.maxDecodedBytes,
		OPENROUTER_SPEECH_REFERENCE_MAX_DECODED_BYTES,
	);
	const maxMetadataBytes = boundedPositiveInteger(
		limits.maxMetadataBytes,
		OPENROUTER_SPEECH_JSON_MAX_METADATA_BYTES,
	);
	const maxRequestBytes = boundedPositiveInteger(
		limits.maxRequestBytes,
		OPENROUTER_SPEECH_JSON_MAX_REQUEST_BYTES,
	);
	const declaredLength = parseDeclaredContentLength(request);
	if (declaredLength != null && declaredLength > maxRequestBytes) {
		await request.body?.cancel('audio_speech_json_request_too_large').catch(() => undefined);
		throw new OpenRouterSpeechJsonError(
			'payload_too_large',
			`Audio speech JSON body must be at most ${maxRequestBytes} bytes`,
		);
	}
	if (!request.body) {
		throw new OpenRouterSpeechJsonError('invalid_json', 'Missing JSON body');
	}

	const reader = request.body.getReader();
	const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const extractor = new StreamingSpeechJsonExtractor(
		new ReferenceAudioDecoder(new BoundedBase64Decoder(maxBase64Bytes, maxDecodedBytes)),
		maxMetadataBytes,
	);
	let receivedBytes = 0;
	try {
		for (;;) {
			const { done, value } = await readWithAbort(reader, request.signal);
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > maxRequestBytes) {
				throw new OpenRouterSpeechJsonError(
					'payload_too_large',
					`Audio speech JSON body must be at most ${maxRequestBytes} bytes`,
				);
			}
			extractor.push(decodeUtf8Chunk(utf8, value, true));
		}
		extractor.push(decodeUtf8Chunk(utf8));
		return extractor.finish();
	} catch (error) {
		await reader.cancel('audio_speech_json_request_rejected').catch(() => undefined);
		if (error instanceof OpenRouterSpeechJsonError) throw error;
		if (request.signal.aborted) {
			throw new OpenRouterSpeechJsonError('cancelled', 'Audio speech request was cancelled');
		}
		throw new OpenRouterSpeechJsonError('invalid_json', 'Invalid JSON body');
	} finally {
		reader.releaseLock();
	}
}
