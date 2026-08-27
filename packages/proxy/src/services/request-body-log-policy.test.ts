import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyRequestBodyLoggingPolicy,
	resolveRequestBodyLoggingMode,
} from './request-body-log-policy';

test('request body logging is off by default and for unknown values', () => {
	assert.equal(resolveRequestBodyLoggingMode(undefined), 'off');
	assert.equal(resolveRequestBodyLoggingMode(''), 'off');
	assert.equal(resolveRequestBodyLoggingMode('full'), 'off');
	assert.equal(resolveRequestBodyLoggingMode(true), 'off');
});

test('redacted mode requires an explicit opt-in', () => {
	assert.equal(resolveRequestBodyLoggingMode('redacted'), 'redacted');
	assert.equal(resolveRequestBodyLoggingMode(' REDACTED '), 'redacted');
});

test('policy drops bodies unless redacted logging is enabled', () => {
	assert.equal(applyRequestBodyLoggingPolicy('{"prompt":"secret"}', 'off'), null);
	assert.equal(applyRequestBodyLoggingPolicy('{"prompt":"[REDACTED]"}', undefined), null);
	assert.equal(
		applyRequestBodyLoggingPolicy('{"prompt":"[REDACTED]"}', 'redacted'),
		'{"prompt":"[REDACTED]"}'
	);
	assert.equal(applyRequestBodyLoggingPolicy(undefined, 'redacted'), null);
});
