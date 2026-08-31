import assert from 'node:assert/strict';
import test from 'node:test';
import {
	readLimitedCinaAuthEventBody,
	sha256Hex,
	signCinaAuthOrganizationEvent,
	verifyCinaAuthOrganizationEventSignature,
} from './organization-event-signature';

const SECRET = 'test-bridge-secret-that-is-at-least-32-characters';
const NOW = 1_787_968_923_000;
const TIMESTAMP = String(Math.floor(NOW / 1000));

test('accepts an authentic body and rejects body tampering', async () => {
	const body = new TextEncoder().encode('{"id":"evt_1"}');
	const signature = await signCinaAuthOrganizationEvent(body, SECRET, TIMESTAMP);
	const request = new Request('https://cinatoken.com/api/integrations/cinaauth/organization-events', {
		headers: {
			'x-cinaauth-event-timestamp': TIMESTAMP,
			'x-cinaauth-signature': signature,
		},
	});
	assert.deepEqual(
		await verifyCinaAuthOrganizationEventSignature(request, body, SECRET, NOW),
		{ ok: true, timestamp: TIMESTAMP },
	);
	assert.deepEqual(
		await verifyCinaAuthOrganizationEventSignature(
			request,
			new TextEncoder().encode('{"id":"evt_2"}'),
			SECRET,
			NOW,
		),
		{ ok: false, reason: 'invalid_signature' },
	);
});

test('rejects stale signatures and caps streaming bodies', async () => {
	const body = new TextEncoder().encode('{}');
	const signature = await signCinaAuthOrganizationEvent(body, SECRET, TIMESTAMP);
	const request = new Request('https://cinatoken.com/', {
		headers: {
			'x-cinaauth-event-timestamp': TIMESTAMP,
			'x-cinaauth-signature': signature,
		},
	});
	assert.deepEqual(
		await verifyCinaAuthOrganizationEventSignature(request, body, SECRET, NOW + 301_000),
		{ ok: false, reason: 'expired' },
	);

	const oversized = new Request('https://cinatoken.com/', {
		method: 'POST',
		body: new Uint8Array(9),
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	await assert.rejects(() => readLimitedCinaAuthEventBody(oversized, 8), /event_body_too_large/u);
});

test('hashes the exact signed bytes', async () => {
	assert.equal(
		await sha256Hex(new TextEncoder().encode('cinatoken')),
		'5d4eaa623fbd03e686f6fffb4ec978f2484172ce72b7f4fa3773f681acfe0d5c',
	);
});
