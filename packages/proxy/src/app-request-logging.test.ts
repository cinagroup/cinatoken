import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, StorageContext } from '@octafuse/core';
import { createProxyApp } from './app';

function messageText(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

describe('gateway request logging privacy', () => {
	it('logs pathname only and never logs query credentials or generation ids', async () => {
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...values: unknown[]) => {
			lines.push(values.map(messageText).join(' '));
		};
		try {
			const app = createProxyApp(async () => ({ repositories: {} as GatewayRepositories } as StorageContext));
			const response = await app.request(
				'/?id=gen-sensitive&key=sk-query-secret',
				{},
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 200);
		} finally {
			console.log = originalLog;
		}

		const serialized = lines.join('\n');
		assert.match(serialized, /"path":"\/"/u);
		assert.doesNotMatch(serialized, /gen-sensitive|sk-query-secret|\?id=|\?key=/u);
	});

	it('does not log any fragment of a rejected Bearer credential', async () => {
		const lines: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		const capture = (...values: unknown[]) => {
			lines.push(values.map(messageText).join(' '));
		};
		console.log = capture;
		console.warn = capture;
		try {
			const repositories = {
				apiKeys: { getApiKeyWithUserByKey: async () => null },
			} as GatewayRepositories;
			const app = createProxyApp(async () => ({ repositories } as StorageContext));
			const response = await app.request(
				'/api/v1/generation?id=gen-sensitive',
				{ headers: { Authorization: 'Bearer sk-sensitive-prefix-and-suffix' } },
				{ REQUEST_BODY_LOGGING: 'off' },
			);
			assert.equal(response.status, 401);
		} finally {
			console.log = originalLog;
			console.warn = originalWarn;
		}

		const serialized = lines.join('\n');
		assert.match(serialized, /api_key_not_found/u);
		assert.doesNotMatch(serialized, /sk-sensitive|prefix|suffix|gen-sensitive/u);
	});
});
