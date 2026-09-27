import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { drainNodeBackgroundWork, pendingNodeBackgroundWorkForTests } from '../runtime/schedule-background-work';
import { createImageCapacityFixture } from './image-capacity-fixture';

// Launched only by the local measurement script; no production runtime import or env storage resolution.
const config = JSON.parse(process.argv[2] ?? '{}') as { upstreamOrigin: string; concurrency: number; operation: 'generations' | 'edits' };
assert.ok(process.send); assert.ok(['generations', 'edits'].includes(config.operation));
const f = await createImageCapacityFixture(config);
const nativeFetch = globalThis.fetch;
let sends = 0, errors = 0, expectedDisconnects = 0;
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.equal(url.origin, config.upstreamOrigin, 'Only this synthetic loopback upstream is permitted');
	assert.equal(url.pathname, `/v1/images/${config.operation}`);
	assert.equal(init?.redirect, 'manual'); sends++;
	return nativeFetch(input, init);
};
// Never retain log arguments, SQL values, Request, Response, or stream chunks in telemetry.
console.log = () => {}; console.warn = () => {};
console.error = (value: unknown) => {
	// The Node adapter logs this exact fixed error when its client disconnects.
	if (value instanceof Error && value.message === 'Gateway response delivery stopped') expectedDisconnects++;
	else errors++;
};
let peak = process.memoryUsage();
let cpu = process.cpuUsage();
const sample = () => {
	const memory = process.memoryUsage();
	for (const key of Object.keys(memory) as (keyof NodeJS.MemoryUsage)[]) peak[key] = Math.max(peak[key], memory[key]);
	return memory;
};
const timer = setInterval(sample, 10); timer.unref();
const report = () => ({ memory: sample(), sampledPeak: { ...peak }, maxRssKiB: process.resourceUsage().maxRSS,
	cpuMicros: process.cpuUsage(cpu), pool: f.pool.snapshot(), stats: { ...f.stats }, sends, errors, expectedDisconnects,
	pendingBackground: pendingNodeBackgroundWorkForTests() });
const server = createAdaptorServer({ fetch: request => f.app.fetch(request, { REQUEST_BODY_LOGGING: 'off' }) });
assert.ok(server instanceof Server);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
process.send!({ event: 'ready', port: address.port, runtime: process.version, v8: process.versions.v8, ...report() });
process.on('message', async (message: { id: number; command: string }) => {
	try {
		if (message.command === 'reset') { peak = process.memoryUsage(); cpu = process.cpuUsage(); }
		else if (message.command === 'release') { f.releaseAccounting(); await drainNodeBackgroundWork(); }
		else if (message.command === 'gc') { assert.ok(globalThis.gc); globalThis.gc(); }
		else if (message.command === 'close') {
			f.releaseAccounting(); server.closeAllConnections();
			await Promise.all([drainNodeBackgroundWork(), new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
			clearInterval(timer); process.send!({ id: message.id, ...report() }, () => process.disconnect()); return;
		} else assert.equal(message.command, 'status');
		process.send!({ id: message.id, ...report() });
	} catch { process.send!({ id: message.id, error: 'Synthetic measurement command failed' }); }
});
