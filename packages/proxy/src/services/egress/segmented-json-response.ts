import { JsonStructureBudget, type JsonStructureLimits } from '../json-structure-budget';
import { consumeResponseTextWithinLimit } from './bounded-response-body';
import { JSON_TEXT_PAGE_CHARS, JsonStringPages } from './json-string-pages';
import { JsonScalar } from './json-scalar';
import { CompactJsonStringPage, decodeJsonStringPage, type JsonStringPage } from './compact-json-string-page';

export const JSON_PARSE_STRING_PIECE_CHARS = 8192;

// Only these units need native quoted-token validation/unescaping. Other units
// are already decoded JSON string content, including literal Unicode/surrogates.
const NEEDS_NATIVE_STRING_PARSE = /["\\\u0000-\u001f]/;

/** Bounded entry count even when the transport delivers one character per read. */
class TextParts {
	private parts: JsonStringPage[] = [];
	private page: string[] = [];
	private pageLength = 0;
	constructor(private readonly pageChars = JSON_TEXT_PAGE_CHARS, private compactPages = false) {}
	setCompactPages(enabled: boolean): void { this.compactPages = enabled; }
	private finishPage(): void {
		if (!this.pageLength) return;
		// Join only a bounded page. Keeping ropes until output can retain both
		// the decoded fragments and newly flattened copies throughout delivery.
		const text = this.page.join('');
		// Compact as each bounded page arrives, never after retaining a whole value.
		this.parts.push(this.compactPages ? CompactJsonStringPage.from(text) : text); this.page = []; this.pageLength = 0;
	}
	append(text: string): void {
		for (let start = 0; start < text.length;) {
			const end = Math.min(text.length, start + this.pageChars - this.pageLength);
			this.page.push(text.slice(start, end)); this.pageLength += end - start; start = end;
			if (this.pageLength === this.pageChars) this.finishPage();
		}
	}
	take(): string {
		this.finishPage();
		const text = this.parts.map(decodeJsonStringPage).join(''); this.clear(); return text;
	}
	takeString(retainPages: boolean): string | JsonStringPages {
		if (!retainPages || this.parts.length === 0) return this.take();
		this.finishPage();
		const value = new JsonStringPages(this.parts); this.clear(); return value;
	}
	clear(): void { this.parts = []; this.page = []; this.pageLength = 0; }
}

const isWhitespace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const isPunctuation = (code: number) => code === 123 || code === 125 || code === 91 || code === 93 || code === 44 || code === 58;
const isDelimiter = (code: number) => isWhitespace(code) || isPunctuation(code) || code === 34;
const invalid = () => new SyntaxError('Invalid JSON response');

/**
 * Extract scalar tokens, then let native JSON.parse validate a compact skeleton.
 * Quoted token references preserve object grammar; numeric references preserve
 * unquoted grammar. Actual keys are restored in source order with data properties,
 * preserving duplicate-key overwrite/order and avoiding __proto__ setters.
 *
 * Escaped/control-containing strings use native parsing of <=8 KiB pieces (plus
 * one complete escape). Plain pieces share bounded decoded input, avoiding a
 * quoted temporary and second decoded copy. Full grammar still uses native parse.
 * No full JSON text is retained. This still owns decoded string values and a bounded
 * skeleton/tree. Numeric grammar is scanned incrementally; bounded significant
 * digits plus tail/exponent state preserve native binary64 rounding without
 * retaining a complete numeric token. Byte admission must remain in force.
 */
class SegmentedJson {
	private mode: 'normal' | 'string' | 'scalar' = 'normal';
	private tokens: Array<string | JsonStringPages | number | boolean | null | undefined> = [];
	private skeleton = new TextParts();
	// Match the native decoded piece size to avoid copying each piece into a
	// second, larger decoded page before streaming it back out.
	private token: TextParts;
	private scalar: JsonScalar | undefined;
	private rawStringPiece = '';
	private escaped = false;
	private unicodeRemaining = 0;
	private whitespace = false;
	private stringIsKey = false;
	// Storage selection only. Full native skeleton parsing remains the grammar
	// authority; structure admission bounds this stack before write() is called.
	private storageScopes: Array<{ object: boolean; keyExpected: boolean; compact: boolean; uncompressedValue: boolean }> = [];
	constructor(private readonly maxSourceBytes: number, private readonly retainStringPages: boolean,
		private readonly nativeStringFields?: ReadonlySet<string>, private readonly uncompressedStringFields?: ReadonlySet<string>) {
		this.token = new TextParts(JSON_PARSE_STRING_PIECE_CHARS, retainStringPages);
	}
	private compactValue(): boolean {
		const scope = this.storageScopes.at(-1);
		return this.retainStringPages && (!scope || (scope.compact && !scope.uncompressedValue));
	}
	private uncompressedRootField(value: string | JsonStringPages): boolean {
		for (const fields of [this.nativeStringFields, this.uncompressedStringFields]) for (const name of fields ?? []) {
			if (name.length !== value.length) continue;
			if (typeof value === 'string') { if (name === value) return true; continue; }
			let offset = 0, matches = true;
			for (const chunk of value.chunks()) { if (!name.startsWith(chunk, offset)) { matches = false; break; } offset += chunk.length; }
			if (matches) return true;
		}
		return false;
	}

	private addToken(value: string | JsonStringPages | number | boolean | null, quoted: boolean): void {
		const index = String(this.tokens.length); this.tokens.push(value);
		this.skeleton.append(quoted ? '"' + index + '"' : index);
		this.whitespace = false; this.mode = 'normal';
	}
	private flushStringPiece(): void {
		if (!this.rawStringPiece) return;
		const value: unknown = NEEDS_NATIVE_STRING_PARSE.test(this.rawStringPiece)
			? JSON.parse('"' + this.rawStringPiece + '"') : this.rawStringPiece;
		if (typeof value !== 'string') throw invalid();
		this.token.append(value); this.rawStringPiece = '';
	}
	private endScalar(): void {
		if (!this.scalar) throw invalid();
		this.addToken(this.scalar.finish(), false); this.scalar = undefined;
	}

	write(text: string): void {
		let i = 0;
		while (i < text.length) {
			if (this.mode === 'scalar') {
				const start = i;
				while (i < text.length && !isDelimiter(text.charCodeAt(i))) i++;
				this.scalar!.write(text.slice(start, i));
				if (i < text.length) this.endScalar();
				continue;
			}
			if (this.mode === 'string') {
				let start = i;
				while (i < text.length) {
					const code = text.charCodeAt(i);
					if (code === 34 && !this.escaped && !this.unicodeRemaining) {
						this.rawStringPiece += text.slice(start, i); this.flushStringPiece();
						const token = this.token.takeString(this.retainStringPages);
						if (this.stringIsKey && this.storageScopes.length === 1) {
							this.storageScopes[0]!.uncompressedValue = this.uncompressedRootField(token);
						}
						this.addToken(token, true); i++; break;
					}
					if (this.unicodeRemaining) this.unicodeRemaining--;
					else if (this.escaped) { this.escaped = false; if (code === 117) this.unicodeRemaining = 4; }
					else if (code === 92) this.escaped = true;
					i++;
					if (this.rawStringPiece.length + i - start >= JSON_PARSE_STRING_PIECE_CHARS && !this.escaped && !this.unicodeRemaining) {
						this.rawStringPiece += text.slice(start, i); this.flushStringPiece(); start = i;
					}
				}
				if (this.mode === 'string') this.rawStringPiece += text.slice(start, i);
				continue;
			}
			const code = text.charCodeAt(i);
			if (isWhitespace(code)) {
				if (!this.whitespace) this.skeleton.append(' ');
				this.whitespace = true; i++;
			} else if (isPunctuation(code)) {
				if (code === 123 || code === 91) this.storageScopes.push({ object: code === 123, keyExpected: code === 123,
					compact: this.compactValue(), uncompressedValue: false });
				else if (code === 125 || code === 93) this.storageScopes.pop();
				else {
					const scope = this.storageScopes.at(-1);
					if (scope) { scope.keyExpected = code === 44 && scope.object; if (code === 44) scope.uncompressedValue = false; }
				}
				this.skeleton.append(text[i]!); this.whitespace = false; i++;
			} else if (code === 34) {
				const scope = this.storageScopes.at(-1);
				this.stringIsKey = scope?.object === true && scope.keyExpected;
				// Keys and explicitly known native subtrees must not add packed bytes
				// alongside the full decoded copies required by their legacy boundary.
				this.token.setCompactPages(!this.stringIsKey && this.compactValue());
				this.mode = 'string'; this.escaped = false; this.unicodeRemaining = 0; i++;
			} else { this.mode = 'scalar'; this.scalar = new JsonScalar(Math.ceil(this.maxSourceBytes)); }
		}
	}

	finish(signal?: AbortSignal): unknown {
		signal?.throwIfAborted();
		if (this.mode === 'string') throw invalid();
		if (this.mode === 'scalar') this.endScalar();
		const skeleton: unknown = JSON.parse(this.skeleton.take());
		const consumeToken = (reference: string | number) => {
			signal?.throwIfAborted();
			const index = Number(reference), token = this.tokens[index];
			if (token === undefined) throw invalid();
			// Every skeleton reference is unique. Transfer ownership now, not after
			// the entire tree has been restored; native keys need not retain pages.
			this.tokens[index] = undefined;
			return token;
		};
		const discard = (value: unknown): void => {
			signal?.throwIfAborted();
			if (typeof value === 'string' || typeof value === 'number') { consumeToken(value); return; }
			if (Array.isArray(value)) { for (const child of value) discard(child); return; }
			if (value === null || typeof value !== 'object') throw invalid();
			for (const [reference, child] of Object.entries(value)) { consumeToken(reference); discard(child); }
		};
		const restore = (value: unknown, retainPages = this.retainStringPages, root = true): unknown => {
			signal?.throwIfAborted();
			if (typeof value === 'string' || typeof value === 'number') {
				const token = consumeToken(value);
				const restored = !retainPages && token instanceof JsonStringPages ? token.materialize() : token;
				signal?.throwIfAborted();
				return restored;
			}
			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) value[i] = restore(value[i], retainPages, false);
				return value;
			}
			if (value === null || typeof value !== 'object') throw invalid();
			// Resolve actual names before restoring children. Use the final object's
			// own data properties for duplicate resolution, not an extra Map holding
			// all full native names alongside engine-internalized property keys.
			// The full wire already passed grammar/budgets, even discarded tokens.
			const result: Record<string, unknown> = {};
			for (const [reference, child] of Object.entries(value)) {
				const token = consumeToken(reference);
				// JavaScript object property names still require native strings.
				const name = token instanceof JsonStringPages ? token.materialize() : token;
				signal?.throwIfAborted();
				if (typeof name !== 'string') throw invalid();
				if (Object.hasOwn(result, name)) discard(result[name]);
				Object.defineProperty(result, name, { value: child, writable: true, enumerable: true, configurable: true });
			}
			for (const name of Object.keys(result)) {
				const childPages = retainPages && !(root && this.nativeStringFields?.has(name));
				// Every name already has an own writable data property, including
				// __proto__; assignment cannot invoke an inherited prototype setter.
				result[name] = restore(result[name], childPages, false);
			}
			return result;
		};
		const restored = restore(skeleton);
		signal?.throwIfAborted();
		return restored;
	}

	dispose(): void {
		this.tokens = []; this.skeleton.clear(); this.token.clear(); this.rawStringPiece = ''; this.scalar = undefined;
		this.storageScopes = [];
	}
}

/**
 * Full EOF/limits/syntax precede handoff. Malformed JSON retains the 500-char preview.
 * retainStringPages is internal opt-in: consumers must use the streaming encoder
 * or explicitly materialize the necessary subtree before crossing a legacy boundary.
 */
export async function segmentedJsonResponseWithinLimit(
	response: Response, maxBytes: number, limits: JsonStructureLimits, signal?: AbortSignal,
	options: {
		retainStringPages?: boolean;
		/** With paged values enabled, explicitly restore these root fields (whole subtrees) as native strings. */
		nativeStringFields?: readonly string[];
		/** Keep decoded pages in these root subtrees for a later full native boundary; value semantics stay paged. */
		uncompressedStringFields?: readonly string[];
	} = {},
): Promise<{ body: unknown; jsonValid: boolean }> {
	const budget = new JsonStructureBudget(limits), parser = new SegmentedJson(
		maxBytes,
		options.retainStringPages === true,
		options.nativeStringFields ? new Set(options.nativeStringFields) : undefined,
		options.uncompressedStringFields ? new Set(options.uncompressedStringFields) : undefined,
	);
	let preview = '', seenText = false, valid = true;
	try {
		await consumeResponseTextWithinLimit(response, maxBytes, text => {
			budget.write(text); // Count duplicate/unknown tokens before any value allocation.
			if (text) seenText = true;
			if (preview.length < 500) preview += text.slice(0, 500 - preview.length);
			if (!valid) return;
			try { parser.write(text); }
			catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				valid = false; parser.dispose();
			}
		}, signal);
		if (!seenText) return { body: null, jsonValid: true }; // Preserve empty-body material semantics.
		if (valid) {
			try { return { body: parser.finish(signal), jsonValid: true }; }
			catch (error) {
				// A caller's cancellation reason can itself be a SyntaxError. Never
				// reclassify a stopped restore as an invalid-JSON provider response.
				signal?.throwIfAborted();
				if (!(error instanceof SyntaxError)) throw error;
			}
		}
		return { body: { error: { message: preview || 'Invalid upstream JSON' } }, jsonValid: false };
	} finally { parser.dispose(); }
}
