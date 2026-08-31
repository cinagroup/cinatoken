import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWebSearchProviderInput } from './web-search';

describe('web-search provider input projection', () => {
	it('normalizes and deduplicates every domain string sent to the provider', () => {
		assert.deepEqual(parseWebSearchProviderInput({
			query: '  current docs  ',
			allowed_domains: [
				'HTTPS://Docs.Example.com/reference',
				'docs.example.com',
			],
		}), {
			ok: true,
			value: {
				query: 'current docs',
				allowedDomains: ['docs.example.com'],
			},
		});
	});

	it('rejects malformed domain arrays and post-Guardrail invalid domains', () => {
		assert.deepEqual(parseWebSearchProviderInput({
			query: 'current docs',
			allowed_domains: ['valid.example', 42],
		}), {
			ok: false,
			error: 'allowed_domains must contain only non-empty domain strings',
		});
		assert.deepEqual(parseWebSearchProviderInput({
			query: 'current docs',
			allowed_domains: ['[REDACTED:secret].example'],
		}), {
			ok: false,
			error: 'allowed_domains contains an invalid domain',
		});
	});

	it('rechecks allow/block mutual exclusion on the projected value', () => {
		assert.deepEqual(parseWebSearchProviderInput({
			query: 'current docs',
			allowed_domains: ['docs.example.com'],
			blocked_domains: ['private.example.com'],
		}), {
			ok: false,
			error: 'Cannot specify both allowed_domains and blocked_domains',
		});
	});
});
