import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import upstream, { outputSizes, responseParts, syntheticResponse, SYNTHETIC_PROVIDER_MARKER, UPSTREAM_ORIGIN, type ImageCase } from './images-upstream';

for (const mode of Object.keys(outputSizes) as ImageCase[]) {
	test(`synthetic ${mode} response is exact, pull-streamed and bounded per chunk`, async () => {
		const response = syntheticResponse(mode, 123);
		assert.equal(response.headers.get('X-Request-ID'), `c02-${mode}-123`);
		assert.ok(response.body);
		let bytes = 0, largest = 0;
		const actual = createHash('sha256');
		for await (const chunk of response.body) { bytes += chunk.length; largest = Math.max(largest, chunk.length); actual.update(chunk); }
		assert.equal(bytes, outputSizes[mode]); assert.ok(largest <= 65536);
		const { prefix, suffix } = responseParts(), expected = createHash('sha256').update(prefix);
		let remaining = bytes - prefix.length - suffix.length;
		const page = Buffer.alloc(8192, mode === 'replacement' ? 255 : 65);
		while (remaining > 0) { const n = Math.min(page.length, remaining); expected.update(page.subarray(0, n)); remaining -= n; }
		assert.equal(actual.digest('hex'), expected.update(suffix).digest('hex'));
	});
}

test('private fixture rejects unexpected paths, origin, method, marker and wire lengths', async () => {
	const url = UPSTREAM_ORIGIN + '/cases/small/v1/images/generations';
	const valid = { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${SYNTHETIC_PROVIDER_MARKER}`, 'Content-Length': '2' } };
	for (const [request, status] of [
		[new Request(url.replace('.invalid', '.com'), valid), 404],
		[new Request(url + '?mode=over', valid), 404],
		[new Request(url.replace('/small/', '/other/'), valid), 404],
		[new Request(url), 404],
		[new Request(url, { ...valid, headers: { 'Content-Length': '2' } }), 422],
		[new Request(url, { ...valid, headers: { ...valid.headers, 'Content-Length': '3' } }), 422],
	] as const) assert.equal((await upstream.fetch(request)).status, status);
	const response = await upstream.fetch(new Request(url, valid));
	assert.equal(response.status, 200); assert.equal(response.headers.get('X-Request-ID'), 'c02-small-2-' + createHash('sha256').update('{}').digest('hex'));
	assert.deepEqual((await response.json() as { usage: unknown }).usage, { input_tokens: 3, output_tokens: 7 });
});

test('fixture drains incrementally and rejects request bodies over its framing allowance', async () => {
	let emitted = 0, canceled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(c) { emitted++; c.enqueue(new Uint8Array(65536)); }, cancel() { canceled = true; },
	}, { highWaterMark: 0 });
	// Node's client Request requires duplex; Workers' RequestInit does not expose it.
	const init = {
		method: 'POST', body, duplex: 'half', headers: { Authorization: `Bearer ${SYNTHETIC_PROVIDER_MARKER}` },
	};
	const response = await upstream.fetch(new Request(UPSTREAM_ORIGIN + '/cases/small/v1/images/edits', init));
	assert.equal(response.status, 413); assert.equal(emitted, 51 * 16 + 1); assert.equal(canceled, true);
});
