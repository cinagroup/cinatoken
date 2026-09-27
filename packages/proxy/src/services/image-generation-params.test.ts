import assert from 'node:assert/strict';
import { it } from 'node:test';
import { normalizeImageGenerationParams } from './image-generation-params';
import { normalizeImageCommonParams, IMAGE_MAX_PROMPT_CHARS } from './egress/openai-images-driver';
import { JsonStringPages } from './egress/json-string-pages';
import { readImageJsonRequest } from './image-json-request';

const samples: Array<[string, unknown]> = [
	['empty', ''], ['whitespace', ' \t\ufeff\u2000'.repeat(5000)],
	['padded-limit', ' '.repeat(20000) + 'A'.repeat(IMAGE_MAX_PROMPT_CHARS) + '\ufeff'.repeat(8192)],
	['padded-overflow', ' '.repeat(20000) + 'A'.repeat(IMAGE_MAX_PROMPT_CHARS + 1)],
	['unicode', ' '.repeat(8191) + '💡Ā\ud800\n' + '\u2000'.repeat(8192)],
	['non-whitespace', '\u0085\u200b'.repeat(5000)],
	['array', ['A'.repeat(20000)]], ['record', { text: 'A'.repeat(20000) }],
	['null', null], ['number', 42], ['boolean', false],
];
for (const [label, prompt] of samples) for (const invalidRest of [false, true]) {
	it(`generation prompt ${label} preserves native normalization and error precedence, invalidRest=${invalidRest}`, async t => {
		const input = { prompt, n: invalidRest ? 'invalid' : '1', size: invalidRest ? [] : ' auto ', quality: ' auto ', background: null };
		const expected = normalizeImageCommonParams(input);
		const materialize = JsonStringPages.prototype.materialize;
		t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
			assert.ok(this.length <= IMAGE_MAX_PROMPT_CHARS, 'never materialize a raw long prompt');
			return materialize.call(this);
		});
		const parsed = await readImageJsonRequest(new Request('https://synthetic.example.invalid', { method: 'POST', body: JSON.stringify(input) }));
		assert.deepEqual(normalizeImageGenerationParams({ ...parsed, prompt: parsed.prompt }), expected);
	});
}

for (const width of [1, 7, 8192]) {
	it(`fragmented escaped prompt keeps native UTF-16 length and trim at width ${width}`, async t => {
		const raw = '{"prompt":"' + ' '.repeat(8191) + '\\ud83d\\udca1\\u0100\\ud800' + ' '.repeat(8192) + '"}';
		const bytes = new TextEncoder().encode(raw); let offset = 0;
		const body = new ReadableStream<Uint8Array>({ pull(c) {
			if (offset === bytes.length) { c.close(); return; }
			const end = Math.min(bytes.length, offset + width); c.enqueue(bytes.subarray(offset, end)); offset = end;
		} }, { highWaterMark: 0 });
		const materialize = JsonStringPages.prototype.materialize;
		t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) { assert.ok(this.length <= 4000); return materialize.call(this); });
		const req = new Request('https://synthetic.example.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit);
		const parsed = await readImageJsonRequest(req);
		assert.deepEqual(normalizeImageGenerationParams({ prompt: parsed.prompt }), normalizeImageCommonParams(JSON.parse(raw)));
	});
}
