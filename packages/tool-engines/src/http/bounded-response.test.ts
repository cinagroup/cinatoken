import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAiDetectionConfigForProvider } from '@octafuse/core/lib/ai-detection-system-config';
import { AiDetectionProviderError, getAiDetectionDriver } from '../ai-detection';
import { deepSearchFirecrawl, deepSearchJina, WebDeepSearchProviderError } from '../web-deep-search';
import { fetchFirecrawlUrl, fetchJinaUrl, fetchTavilyUrl, WebFetchProviderError } from '../web-fetch';
import {
	searchBochaWeb,
	searchCleverSeeWeb,
	searchTavilyWeb,
	searchTencentWsaWeb,
	WebSearchProviderError,
} from '../web-search';
import {
	assertToolProviderOutputWithinLimit,
	readToolProviderResponseText,
	TOOL_PROVIDER_OUTPUT_MAX_BYTES,
	TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE,
	TOOL_PROVIDER_RESPONSE_MAX_BYTES,
	TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE,
} from './bounded-response';

class TestProviderError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly provider: string,
	) {
		super(message);
	}
}

function responseWithDeclaredOversize(): {
	response: Response;
	cancelReason: () => unknown;
} {
	let cancelled: unknown;
	const body = new ReadableStream<Uint8Array>({
		cancel(reason) {
			cancelled = reason;
		},
	});
	return {
		response: new Response(body, {
			headers: { 'content-length': String(TOOL_PROVIDER_RESPONSE_MAX_BYTES + 1) },
		}),
		cancelReason: () => cancelled,
	};
}

function fetchReturning(response: Response): typeof fetch {
	return async () => response;
}

describe('bounded Tool provider response reader', () => {
	it('cancels immediately when content-length declares an oversized body', async () => {
		const oversized = responseWithDeclaredOversize();
		await assert.rejects(readToolProviderResponseText(oversized.response, {
			provider: 'test', errorConstructor: TestProviderError,
		}), (error: unknown) => {
			assert.ok(error instanceof TestProviderError);
			assert.equal(error.status, 502);
			assert.equal(error.message, TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE);
			return true;
		});
		assert.equal(oversized.cancelReason(), 'tool_provider_response_too_large');
	});

	it('cancels when streaming bytes cross the ceiling and decodes split UTF-8 safely below it', async () => {
		let cancelReason: unknown;
		let pullCount = 0;
		const oversizedBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1;
				controller.enqueue(new Uint8Array([1, 2, 3, 4]));
			},
			cancel(reason) {
				cancelReason = reason;
			},
		});
		await assert.rejects(readToolProviderResponseText(new Response(oversizedBody), {
			provider: 'test', errorConstructor: TestProviderError, maxBytes: 5,
		}), TestProviderError);
		assert.equal(pullCount, 2);
		assert.equal(cancelReason, 'tool_provider_response_too_large');

		const encoded = new TextEncoder().encode('A中B');
		const boundedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoded.subarray(0, 2));
				controller.enqueue(encoded.subarray(2));
				controller.close();
			},
		});
		assert.equal(await readToolProviderResponseText(new Response(boundedBody), {
			provider: 'test', errorConstructor: TestProviderError, maxBytes: encoded.byteLength,
		}), 'A中B');
	});

	it('bounds mapped output before Response.json serialization', () => {
		assert.throws(() => assertToolProviderOutputWithinLimit({
			content: 'x'.repeat(TOOL_PROVIDER_OUTPUT_MAX_BYTES),
		}, {
			provider: 'test', errorConstructor: TestProviderError,
		}), (error: unknown) => {
			assert.ok(error instanceof TestProviderError);
			assert.equal(error.message, TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE);
			return true;
		});
	});
});

describe('Tool provider clients use the shared response bound', () => {
	const resolved = resolveAiDetectionConfigForProvider({
		tencent_tms: {
			secretId: 'id', secretKey: 'key',
			cost: 0.01, metered: 0.01, standard: 0.01, charged: 0.01,
		},
	}, 'tencent_tms');
	assert.equal(resolved.ok, true);
	if (!resolved.ok) throw new Error('test AI detection config must resolve');
	const detectionDriver = getAiDetectionDriver('tencent_tms');
	assert.ok(detectionDriver);

	const cases: Array<{
		name: string;
		errorConstructor: new (message: string, status: number, provider: string) => Error;
		invoke: (fetchImpl: typeof fetch) => Promise<unknown>;
	}> = [
		{ name: 'Bocha search', errorConstructor: WebSearchProviderError, invoke: (fetchImpl) => searchBochaWeb({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'CleverSee search', errorConstructor: WebSearchProviderError, invoke: (fetchImpl) => searchCleverSeeWeb({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'Tavily search', errorConstructor: WebSearchProviderError, invoke: (fetchImpl) => searchTavilyWeb({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'Tencent WSA search', errorConstructor: WebSearchProviderError, invoke: (fetchImpl) => searchTencentWsaWeb({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'Firecrawl fetch', errorConstructor: WebFetchProviderError, invoke: (fetchImpl) => fetchFirecrawlUrl({ apiKey: 'key', url: 'https://example.com', fetchImpl }) },
		{ name: 'Jina fetch', errorConstructor: WebFetchProviderError, invoke: (fetchImpl) => fetchJinaUrl({ apiKey: 'key', url: 'https://example.com', fetchImpl }) },
		{ name: 'Tavily fetch', errorConstructor: WebFetchProviderError, invoke: (fetchImpl) => fetchTavilyUrl({ apiKey: 'key', url: 'https://example.com', fetchImpl }) },
		{ name: 'Firecrawl deep search', errorConstructor: WebDeepSearchProviderError, invoke: (fetchImpl) => deepSearchFirecrawl({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'Jina deep search', errorConstructor: WebDeepSearchProviderError, invoke: (fetchImpl) => deepSearchJina({ apiKey: 'key', query: 'query', fetchImpl }) },
		{ name: 'Tencent TMS detection', errorConstructor: AiDetectionProviderError, invoke: (fetchImpl) => detectionDriver.detectSegment('text', resolved.config, { fetchImpl }) },
	];

	for (const testCase of cases) {
		it(`${testCase.name} cancels declared oversize bodies as a provider error`, async () => {
			const oversized = responseWithDeclaredOversize();
			await assert.rejects(testCase.invoke(fetchReturning(oversized.response)), (error: unknown) => {
				assert.ok(error instanceof testCase.errorConstructor);
				assert.equal(error.message, TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE);
				assert.equal((error as { status: number }).status, 502);
				return true;
			});
			assert.equal(oversized.cancelReason(), 'tool_provider_response_too_large');
		});
	}

	it('rejects oversized normalized web-search, web-fetch, and deep-search outputs', async () => {
		const duplicatedSearchContent = 's'.repeat(Math.floor(TOOL_PROVIDER_OUTPUT_MAX_BYTES / 2) + 1024);
		await assert.rejects(searchTavilyWeb({
			apiKey: 'key', query: 'query',
			fetchImpl: fetchReturning(Response.json({
				results: [{ title: 'result', url: 'https://example.com', content: duplicatedSearchContent }],
			})),
		}), (error: unknown) => error instanceof WebSearchProviderError
			&& error.message === TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE);

		const largeContent = 'f'.repeat(TOOL_PROVIDER_OUTPUT_MAX_BYTES);
		await assert.rejects(fetchJinaUrl({
			apiKey: 'key', url: 'https://example.com',
			fetchImpl: fetchReturning(Response.json({
				data: { url: 'https://example.com', content: largeContent },
			})),
		}), (error: unknown) => error instanceof WebFetchProviderError
			&& error.message === TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE);

		await assert.rejects(deepSearchFirecrawl({
			apiKey: 'key', query: 'query',
			fetchImpl: fetchReturning(Response.json({
				data: [{ title: 'result', url: 'https://example.com', markdown: largeContent }],
			})),
		}), (error: unknown) => error instanceof WebDeepSearchProviderError
			&& error.message === TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE);
	});
});
