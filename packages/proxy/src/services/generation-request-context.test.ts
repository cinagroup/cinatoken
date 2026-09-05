import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	generationRequestContext,
	generationRequestLogContext,
	normalizeGenerationHttpReferer,
	normalizeGenerationUserAgent,
} from './generation-request-context';

describe('Generation request-context snapshots', () => {
	it('keeps only a credential-free HTTP(S) application origin', () => {
		assert.equal(
			normalizeGenerationHttpReferer('https://app.example/path?token=secret#private'),
			'https://app.example',
		);
		assert.equal(normalizeGenerationHttpReferer('http://localhost:3000/dashboard'), 'http://localhost:3000');
		assert.equal(normalizeGenerationHttpReferer('https://user:secret@app.example/path'), null);
		assert.equal(normalizeGenerationHttpReferer('data:text/plain,hello'), null);
	});

	it('bounds User-Agent and rejects unsafe values', () => {
		assert.equal(normalizeGenerationUserAgent('  CinaSDK/1.0  '), 'CinaSDK/1.0');
		assert.equal(normalizeGenerationUserAgent('unsafe\nvalue'), null);
		assert.equal(normalizeGenerationUserAgent('x'.repeat(513)), null);
	});

	it('reads only the explicit OpenRouter application header', () => {
		assert.deepEqual(generationRequestContext(new Headers({
			Referer: 'https://browser.example/private?token=secret',
			'HTTP-Referer': 'https://app.example/product?token=secret',
			'User-Agent': 'CinaSDK/1.0',
		})), {
			httpReferer: 'https://app.example',
			userAgent: 'CinaSDK/1.0',
		});
		assert.deepEqual(generationRequestLogContext(new Headers({
			'HTTP-Referer': 'https://app.example/private',
			'User-Agent': 'CinaSDK/1.0',
		})), {
			http_referer: 'https://app.example',
			user_agent: 'CinaSDK/1.0',
		});
	});
});
