import assert from 'node:assert/strict';
import test from 'node:test';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';

const TOKEN = 'a-production-length-diagnostic-token-value';

test('diagnostic authentication fails closed without a strong configured token', async () => {
	const request = new Request('https://diagnostic.invalid/', {
		headers: { Authorization: `Bearer ${TOKEN}` },
	});
	assert.equal(await isDiagnosticRequestAuthorized(request, undefined), false);
	assert.equal(await isDiagnosticRequestAuthorized(request, 'short'), false);
});

test('diagnostic authentication requires an exact bearer token', async () => {
	assert.equal(
		await isDiagnosticRequestAuthorized(new Request('https://diagnostic.invalid/'), TOKEN),
		false,
	);
	assert.equal(
		await isDiagnosticRequestAuthorized(new Request('https://diagnostic.invalid/', {
			headers: { Authorization: 'Bearer wrong-production-length-diagnostic-token' },
		}), TOKEN),
		false,
	);
	assert.equal(
		await isDiagnosticRequestAuthorized(new Request('https://diagnostic.invalid/', {
			headers: { Authorization: `Bearer ${TOKEN}` },
		}), TOKEN),
		true,
	);
});
