import assert from 'node:assert/strict';
import { it } from 'node:test';
import { JsonScalar } from './json-scalar';
import { JsonStringPages } from './json-string-pages';
import { jsonStringNumber } from './json-string-number';

const paged = (text: string, width = 8192) => new JsonStringPages(
	Array.from({ length: Math.ceil(text.length / width) }, (_, i) => text.slice(i * width, (i + 1) * width)),
);
const same = (text: string, width = 8192) => {
	const expected = Number(text);
	assert.ok(Object.is(jsonStringNumber(text), expected), `native: ${text.slice(0, 60)}`);
	assert.ok(Object.is(jsonStringNumber(paged(text, width)), expected), `paged: ${text.slice(0, 60)}`);
};

for (const width of [1, 7, 8191, 8192, 65536]) it(`Number string grammar, padding and invalid forms match native conversion, width ${width}`, () => {
	const zeros = '0'.repeat(1100);
	for (const text of ['', ' ', '\t\n\r\v\f\u00a0\ufeff', '3', '-0', '+0', '.5', '1.', '1.e2', '+01', 'Infinity', '-Infinity', '+Infinity',
		'0xff', '0O77', '0b101', '-0x1', '+0b1', 'NaN', 'null', 'true', '1_000', '3n', '.', '+.', '.e1', '1 e2', '\u00853', '\u200b3',
		zeros + '3', '+' + zeros + '3.', '-' + zeros + '0', zeros + '3.e+2', '.' + zeros + '5e1101', '-.' + zeros + '5e1101',
		'1.' + zeros, '1e+' + zeros + '2', '1e-' + '9'.repeat(1100), '-0e' + '9'.repeat(1100), '1' + zeros + 'e-1100',
		'0x' + zeros + 'ff', '0O' + zeros + '77', '0b' + zeros + '11', '0x' + 'f'.repeat(1100) + 'z',
		zeros + '3e', zeros + '3e+', zeros + '..1', zeros + '3e.1', zeros + '3n', zeros + '3_0', zeros + '3\u200b',
		'+' + zeros + 'x1', '0x' + zeros + '.1', '0b' + zeros + '2', '0o' + zeros + '8', zeros + ' 3']) {
		same(text, width); same(' \ufeff' + text + '\u2028\t', width);
	}
});

it('every native trim whitespace code point is accepted and non-whitespace stays invalid', () => {
	for (let code = 0; code <= 0xffff; code++) {
		const unit = String.fromCharCode(code);
		if (unit.trim() === '') same(unit.repeat(1100) + '-0' + unit.repeat(1100));
	}
	for (const unit of ['\u0085', '\u180e', '\u200b', '\ufffd', '\ud800', '\udc00', '\u0000']) same(unit.repeat(1100) + '3');
});

for (const [prefix, radix] of [['0b', 2], ['0o', 8], ['0x', 16]] as const) it(`${prefix}: integer rounding agrees with native conversion at all binary64 exponent boundaries`, () => {
	for (let exponent = 1; exponent <= 1025; exponent++) {
		const power = 1n << BigInt(exponent);
		const halfUlp = exponent > 53 ? 1n << BigInt(exponent - 53) : 1n;
		for (const n of [power - 1n, power, power + 1n, power + halfUlp - 1n, power + halfUlp, power + halfUlp + 1n]) {
			const text = prefix + '0'.repeat(1025) + n.toString(radix);
			same(text, exponent % 2 ? 7 : 8192);
		}
	}
});

it('long decimal string syntax keeps native rounding across seeded mantissas and exponent placement', () => {
	let seed = 0x3751ac;
	const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	for (let run = 0; run < 1500; run++) {
		const length = random() % 4000 + 1025;
		let digits = ''; for (let i = 0; i < length; i++) digits += String(random() % 10);
		const point = random() % (length + 1), exponent = random() % 700 - 350 - point;
		const text = ['+', '-', ''][run % 3] + '0'.repeat(run % 11) + digits.slice(0, point) + '.' + digits.slice(point) + 'e' + exponent;
		same(text, random() % 8192 + 1);
	}
});

it('long decimal strings round both sides of exact subnormal and normal midpoints', () => {
	const midpoint = '1.00000000000000011102230246251565404236316680908203125';
	const subnormal = (5n ** 1075n).toString();
	for (const zeros of [1024, 8192, 65536]) {
		for (const sign of ['', '+', '-']) {
			same(sign + midpoint + '0'.repeat(zeros));
			same(sign + midpoint + '0'.repeat(zeros) + '1');
			same(sign + '0.' + subnormal.padStart(1075, '0') + '0'.repeat(zeros));
			same(sign + '0.' + subnormal.padStart(1075, '0') + '0'.repeat(zeros) + '1');
		}
	}
});

it('numeric conversion never joins a long value, including padded short numbers and radix overflow', t => {
	const original = JsonStringPages.prototype.materialize, lengths: number[] = [];
	t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
		lengths.push(this.length); assert.ok(this.length <= 1024); return original.call(this);
	});
	for (const text of [' '.repeat(2 ** 20) + '3', '0'.repeat(2 ** 20) + '3', '1' + '0'.repeat(2 ** 20) + 'e-1048576',
		'0x' + '0'.repeat(2 ** 20) + 'ff', '0b' + '1'.repeat(2 ** 20), '0o' + '7'.repeat(2 ** 20) + 'x']) same(text);
	assert.deepEqual(lengths, [1]);
});

for (const shape of ['trim', 'decimal', 'radix']) it(`numeric conversion propagates cancellation during ${shape}, even a SyntaxError reason`, () => {
	const text = shape === 'trim' ? ' '.repeat(200000) + '3' : shape === 'decimal' ? '0'.repeat(200000) + '3' : '0x' + '0'.repeat(200000) + '3';
	let checks = 0; const reason = new SyntaxError('Synthetic cancellation');
	assert.throws(() => jsonStringNumber(paged(text), () => { if (++checks === 12) throw reason; }), error => error === reason);
	assert.equal(checks, 12);
});

it('Number string extensions do not relax the default JSON scalar grammar', () => {
	for (const text of ['+1', '01', '.5', '-.5', '1.', '1.e2', '0x10', 'Infinity', ' 1', '1 ']) {
		const scalar = new JsonScalar(text.length);
		assert.throws(() => { scalar.write(text); scalar.finish(); }, SyntaxError);
	}
});
