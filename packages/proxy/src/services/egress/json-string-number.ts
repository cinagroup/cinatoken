import { JsonScalar } from './json-scalar';
import { JsonStringPages, jsonStringChunks } from './json-string-pages';

/** Number(string)'s unsigned binary/octal/hex integer with bounded rounding state. */
function radixNumber(value: string | JsonStringPages, bitsPerDigit: number, checkActive?: () => void): number {
	let position = 0, digits = 0, bits = 0, significand = 0, guard = 0, sticky = false;
	const radix = 2 ** bitsPerDigit;
	for (const chunk of jsonStringChunks(value)) {
		for (let i = 0; i < chunk.length; i++) {
			if (i % 8192 === 0) checkActive?.();
			if (position++ < 2) continue;
			const code = chunk.charCodeAt(i), digit = code >= 48 && code <= 57 ? code - 48
				: code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
			if (digit < 0 || digit >= radix) return NaN;
			digits++;
			if (bits > 1024) continue; // Still validate every later digit after overflow.
			for (let shift = bitsPerDigit - 1; shift >= 0; shift--) {
				const bit = (digit >> shift) & 1;
				if (bits === 0 && bit === 0) continue;
				bits++;
				if (bits <= 53) significand = significand * 2 + bit;
				else if (bits === 54) guard = bit;
				else sticky ||= bit !== 0;
			}
		}
	}
	if (!digits) return NaN;
	if (bits > 1024) return Infinity;
	if (bits <= 53) return significand;
	if (guard && (sticky || significand % 2 === 1)) significand++;
	return significand * 2 ** (bits - 53);
}

/**
 * Native Number string semantics for decoded immutable JSON strings, without
 * joining a long numeric value. Not a JSON grammar change. Short strings (incl.
 * Infinity/empty) use Number directly; long decimals reuse bounded significant
 * digits with StringNumericLiteral syntax; radix integers round binary bits once.
 */
export function jsonStringNumber(value: string | JsonStringPages, checkActive?: () => void): number {
	checkActive?.();
	const text = value instanceof JsonStringPages ? value.trim(checkActive) : value.trim();
	checkActive?.();
	if (text.length <= 1024) return Number(typeof text === 'string' ? text : text.materialize());
	let prefix = '';
	for (const chunk of jsonStringChunks(text)) { prefix += chunk.slice(0, 2 - prefix.length); if (prefix.length === 2) break; }
	if (/^0[xob]$/i.test(prefix)) return radixNumber(text, prefix[1]!.toLowerCase() === 'x' ? 4 : prefix[1]!.toLowerCase() === 'o' ? 3 : 1, checkActive);
	const scalar = new JsonScalar(text.length, true);
	for (const chunk of jsonStringChunks(text)) {
		for (let i = 0; i < chunk.length; i += 8192) {
			checkActive?.();
			try { scalar.write(chunk.slice(i, i + 8192)); }
			catch (error) { if (error instanceof SyntaxError) return NaN; throw error; }
		}
	}
	try { const result = scalar.finish(); return typeof result === 'number' ? result : NaN; }
	catch (error) { if (error instanceof SyntaxError) return NaN; throw error; }
}
