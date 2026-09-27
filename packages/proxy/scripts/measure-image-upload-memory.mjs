// Local synthetic upload only. Separate Node processes; no network, credentials, or business DB.
// These observed samples are NOT a Workers isolate or whole-gateway peak-memory proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!mode) {
	const runs = [];
	for (const candidate of ['native', 'paged']) {
		const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), candidate],
			{ encoding: 'utf8', timeout: 60000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		runs.push(JSON.parse(child.stdout));
	}
	console.log(JSON.stringify({ runtime: process.version, scope: 'synthetic upload parse + serialized upload; observed samples, not continuous peak', runs }, null, 2));
} else {
	assert.ok(mode === 'native' || mode === 'paged');
	const { boundRequestBody, MAX_REQUEST_BODY_BYTES } = await import('../src/services/bounded-request-body.ts');
	const { createMultipartBodyInspector } = await import('../src/services/multipart-body-inspector.ts');
	const { MultipartFile, readStreamingMultipartBody, MULTIPART_FILE_PAGE_BYTES } = await import('../src/services/streaming-multipart-body.ts');
	const { createMultipartUploadBody } = await import('../src/services/egress/multipart-upload-body.ts');
	const { createRequestDeadline } = await import('../src/services/request-deadline.ts');
	const boundary = 'synthetic-memory-boundary', contentType = `multipart/form-data; boundary=${boundary}`;
	const encode = value => new TextEncoder().encode(value), chunk = new Uint8Array(MULTIPART_FILE_PAGE_BYTES).fill(42);
	const head = encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`);
	const crlf = encode('\r\n'), tail = encode(`--${boundary}--\r\n`);
	const maxFileBytes = 20 * 1024 * 1024;
	const sizes = [maxFileBytes, maxFileBytes, MAX_REQUEST_BODY_BYTES - 2 * maxFileBytes - 3 * (head.length + 2) - tail.length];
	const chunks = [];
	for (const size of sizes) {
		chunks.push(head);
		for (let left = size; left > 0; left -= chunk.length) chunks.push(chunk.subarray(0, Math.min(left, chunk.length)));
		chunks.push(crlf);
	}
	chunks.push(tail);
	global.gc();
	const baseline = process.memoryUsage(), maximum = { ...baseline };
	const sample = () => { const current = process.memoryUsage(); for (const key of Object.keys(maximum)) maximum[key] = Math.max(maximum[key], current[key]); return current; };
	let index = 0, rawBytes = 0;
	const source = new ReadableStream({ pull(c) {
		sample(); if (index === chunks.length) c.close(); else { const bytes = chunks[index++]; rawBytes += bytes.length; c.enqueue(bytes); }
	} }, { highWaterMark: 0 });
	const request = new Request('https://synthetic.invalid/', { method: 'POST', body: source, headers: { 'Content-Type': contentType }, duplex: 'half' });
	const deadline = createRequestDeadline(Date.now() + 30000);
	let retained = 0, files, result, upload, input;
	try {
		if (mode === 'native') {
			input = boundRequestBody(source, deadline, MAX_REQUEST_BODY_BYTES, createMultipartBodyInspector(contentType, { maxFiles: 5, maxFileBytes }));
			result = await new Response(input.body, { headers: { 'Content-Type': contentType } }).formData();
			files = result.getAll('image');
		} else {
			result = await readStreamingMultipartBody(request, { maxFiles: 5, maxFileBytes }, deadline);
			files = result.image;
			retained = files.reduce((sum, file) => sum + file.retainedBytes, 0);
		}
		assert.deepEqual(files.map(file => file.size), sizes); assert.equal(rawBytes, MAX_REQUEST_BODY_BYTES);
		const afterParse = sample();
		let body;
		if (mode === 'native') body = new Request('https://synthetic.invalid/', { method: 'POST', body: result }).body;
		else {
			upload = createMultipartUploadBody(new FormData(), files.map(payload => ({ payload, filename: payload.name, mimeType: payload.type })), deadline.signal);
			body = upload.body;
		}
		const reader = body.getReader(); let outboundBytes = 0;
		while (true) { const next = await reader.read(); sample(); if (next.done) break; outboundBytes += next.value.length; }
		reader.releaseLock(); upload?.dispose();
		for (const file of files) if (file instanceof MultipartFile) file.dispose();
		const retainedAfterRelease = files.reduce((sum, file) => sum + (file instanceof MultipartFile ? file.retainedBytes : 0), 0);
		files = undefined; result = undefined; upload = undefined; global.gc(); const afterReleaseGc = sample();
		console.log(JSON.stringify({ mode, rawBytes, fileBytes: sizes, outboundBytes, retainedPageBytes: retained,
			retainedPageBytesAfterRelease: retainedAfterRelease, baseline, afterParse, observedMaximum: maximum, afterReleaseGc }));
	} finally { input?.dispose(); upload?.dispose(); deadline.dispose(); }
}
