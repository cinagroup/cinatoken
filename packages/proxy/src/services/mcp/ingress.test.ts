import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readMcpIngress, MAX_MCP_BODY_BYTES, McpIngressError } from './ingress';
import type { ResourceCompletion } from '../resource-completion';

it('auth and transport share one parsed MCP body with owned EOF confirmation', async () => {
	const request = new Request('https://gateway.test/mcp', {
		method: 'POST',
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
	});
	let completion: ResourceCompletion | undefined;
	const first = await readMcpIngress(request, (task) => {
		completion = task;
	});
	assert.equal(await readMcpIngress(request), first);
	assert.equal(request.bodyUsed, true);
	assert.equal(await completion, 'confirmed');
});
it('rejects oversized ingress without waiting for a stalled cancellation ACK', async () => {
	let cancelled = false;
	const request = new Request('https://gateway.test/mcp', {
		method: 'POST',
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_MCP_BODY_BYTES + 1));
			},
			cancel() {
				cancelled = true;
				return new Promise(() => {});
			},
		}),
		duplex: 'half',
	} as RequestInit);
	let completion: ResourceCompletion | undefined;
	await assert.rejects(
		readMcpIngress(request, (task) => {
			completion = task;
		}),
		(error: unknown) => error instanceof McpIngressError && error.status === 413,
	);
	assert.equal(cancelled, true);
	let settled = false;
	void completion?.then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.equal(settled, false);
});
it('a client abort stops a pending MCP read and keeps cancellation ownership', async () => {
	const abort = new AbortController();
	let cancelled = false;
	const request = new Request('https://gateway.test/mcp', {
		method: 'POST',
		signal: abort.signal,
		body: new ReadableStream({
			cancel() {
				cancelled = true;
			},
		}),
		duplex: 'half',
	} as RequestInit);
	const read = readMcpIngress(request);
	abort.abort();
	await assert.rejects(read, (error: unknown) => error instanceof McpIngressError && error.status === 499);
	assert.equal(cancelled, true);
});
it('rejects malformed MCP JSON consistently on repeated consumers', async () => {
	const request = new Request('https://gateway.test/mcp', { method: 'POST', body: '{' });
	await assert.rejects(readMcpIngress(request), /Invalid MCP JSON body/);
	await assert.rejects(readMcpIngress(request), /Invalid MCP JSON body/);
});
