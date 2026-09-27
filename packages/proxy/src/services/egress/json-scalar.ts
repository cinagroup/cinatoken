// A binary64 rounding boundary needs fewer than 780 significant decimal digits.
// Keep extra margin, then one non-zero-tail marker; native conversion still does
// the actual rounding. Background: google/double-conversion strtod.cc,
// kMaxSignificantDecimalDigits and CutToMaxSignificantDigits. No decimal arithmetic
// is performed on the value itself (which would introduce double rounding).
export const JSON_NUMBER_SIGNIFICANT_DIGITS = 1024;

type State = 'start' | 'sign' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponent-sign' | 'exponent-digits' | 'keyword';
const invalid = () => new SyntaxError('Invalid JSON scalar');

/** Incremental JSON number/true/false/null grammar, with constant token storage. */
export class JsonScalar {
	private state: State = 'start';
	private negative = false;
	private digits = '';
	private significantCount = 0;
	private fractionCount = 0;
	private nonZeroTail = false;
	private exponent = 0;
	private exponentNegative = false;
	private keyword = '';
	private keywordPosition = 0;
	private hasIntegerDigit = false;
	private readonly exponentCeiling: number;

	// stringDecimal is only for Number(decodedString)'s decimal grammar; the JSON
	// parser always uses the strict default. Whitespace/radix/Infinity are handled
	// by jsonStringNumber, not this scalar state machine.
	constructor(maxSourceBytes: number, private readonly stringDecimal = false) {
		// The caller enforces this byte budget before feeding token characters.
		// JSON numeric characters are ASCII. An exponent larger than the whole
		// possible mantissa plus this margin cannot return to the binary64 range.
		if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 0 || maxSourceBytes > Number.MAX_SAFE_INTEGER / 4) {
			throw new RangeError('Invalid JSON scalar source budget');
		}
		this.exponentCeiling = maxSourceBytes + 2048;
	}

	private digit(code: number, fractional: boolean): void {
		if (!fractional) this.hasIntegerDigit = true;
		if (fractional) this.fractionCount++;
		if (this.significantCount === 0 && code === 48) return;
		this.significantCount++;
		if (this.digits.length < JSON_NUMBER_SIGNIFICANT_DIGITS) this.digits += String.fromCharCode(code);
		else if (code !== 48) this.nonZeroTail = true;
	}

	write(text: string): void {
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i), digit = code >= 48 && code <= 57;
			if (this.state === 'keyword') {
				if (text[i] !== this.keyword[this.keywordPosition++]) throw invalid();
				continue;
			}
			if (!this.stringDecimal && this.state === 'start' && (code === 116 || code === 102 || code === 110)) {
				this.keyword = code === 116 ? 'true' : code === 102 ? 'false' : 'null';
				this.keywordPosition = 1; this.state = 'keyword'; continue;
			}
			switch (this.state) {
				case 'start':
					if (code === 45 || (this.stringDecimal && code === 43)) { this.negative = code === 45; this.state = 'sign'; break; }
					// The first digit follows the same rule with or without '-'.
					// falls through
				case 'sign':
					if (this.stringDecimal && code === 46) { this.state = 'dot'; break; }
					if (!digit) throw invalid();
					this.state = code === 48 ? 'zero' : 'integer'; this.digit(code, false); break;
				case 'zero':
				case 'integer':
					if (digit && (this.state === 'integer' || this.stringDecimal)) this.digit(code, false);
					else if (code === 46) this.state = 'dot';
					else if (code === 69 || code === 101) this.state = 'exponent';
					else throw invalid();
					break;
				case 'dot':
					if (this.stringDecimal && this.hasIntegerDigit && (code === 69 || code === 101)) { this.state = 'exponent'; break; }
					if (!digit) throw invalid();
					this.state = 'fraction'; this.digit(code, true); break;
				case 'fraction':
					if (digit) this.digit(code, true);
					else if (code === 69 || code === 101) this.state = 'exponent';
					else throw invalid();
					break;
				case 'exponent':
					if (code === 43 || code === 45) { this.exponentNegative = code === 45; this.state = 'exponent-sign'; break; }
					// falls through
				case 'exponent-sign':
				case 'exponent-digits':
					if (!digit) throw invalid();
					this.state = 'exponent-digits';
					this.exponent = Math.min(this.exponentCeiling, this.exponent * 10 + code - 48); break;
			}
		}
	}

	finish(): number | boolean | null {
		if (this.state === 'keyword') {
			if (this.keywordPosition !== this.keyword.length) throw invalid();
			return this.keyword === 'null' ? null : this.keyword === 'true';
		}
		if (this.state !== 'zero' && this.state !== 'integer' && this.state !== 'fraction' && this.state !== 'exponent-digits'
			&& !(this.stringDecimal && this.hasIntegerDigit && this.state === 'dot')) throw invalid();
		if (this.significantCount === 0) return this.negative ? -0 : 0;
		// Discarded trailing zeros are represented by the exponent. A non-zero
		// tail becomes one sticky digit beyond all possible rounding boundaries.
		const digits = this.digits + (this.nonZeroTail ? '1' : '');
		const exponent = (this.exponentNegative ? -this.exponent : this.exponent)
			- this.fractionCount + this.significantCount - digits.length;
		return Number((this.negative ? '-' : '') + digits + 'e' + exponent);
	}
}
