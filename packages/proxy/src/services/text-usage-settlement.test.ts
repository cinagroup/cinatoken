import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_USAGE } from './proxy';
import {
	hasAuthoritativeTextUsage,
	textUsageCostIsUnknown,
	textUsageWithSafetyTimeout,
} from './text-usage-settlement';

test('explicit zero usage object is authoritative', () => {
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE, raw_usage: '{}' }), true);
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE }), false);
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE, raw_usage: '' }), false);
});

test('HTTP certainty is shared and conservative only after an unknown/2xx outcome', () => {
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: false, usageAvailable: false }), false);
	assert.equal(textUsageCostIsUnknown({
		upstreamResponseOk: false,
		usageAvailable: false,
		upstreamOutcomeUnknown: true,
	}), true);
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: true, usageAvailable: false }), true);
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: true, usageAvailable: true }), false);
	assert.equal(textUsageCostIsUnknown({
		upstreamResponseOk: true,
		usageAvailable: true,
		streamError: true,
	}), true);
});

test('usage safety race clears the timeout when usage wins', async () => {
	let cleared: unknown;
	const handle = { id: 1 };
	const result = await textUsageWithSafetyTimeout(
		Promise.resolve({ ...EMPTY_USAGE, raw_usage: '{}' }),
		300_000,
		EMPTY_USAGE,
		{
			set: () => handle,
			clear: (value) => {
				cleared = value;
			},
		},
	);
	assert.equal(result.timedOut, false);
	assert.equal(result.incomplete, false);
	assert.equal(cleared, handle);
});

test('usage safety race clears the fired timeout too', async () => {
	let cleared = false;
	const result = await textUsageWithSafetyTimeout(
		new Promise(() => undefined),
		1,
		EMPTY_USAGE,
		{
			set: (callback) => {
				queueMicrotask(callback);
				return 'timer';
			},
			clear: () => {
				cleared = true;
			},
		},
	);
	assert.equal(result.timedOut, true);
	assert.equal(cleared, true);
});
