import assert from 'node:assert/strict';
import test from 'node:test';
import {
	generateBootstrapPassword,
	planetScaleConnectionUser,
} from './hyperdrive-bootstrap-worker';

test('bootstrap database passwords are independent URL-safe 256-bit values', () => {
	const first = generateBootstrapPassword();
	const second = generateBootstrapPassword();
	assert.equal(first.length, 43);
	assert.equal(second.length, 43);
	assert.match(first, /^[A-Za-z0-9_-]+$/u);
	assert.match(second, /^[A-Za-z0-9_-]+$/u);
	assert.notEqual(first, second);
});

test('PlanetScale connection usernames include the branch routing suffix', () => {
	assert.equal(
		planetScaleConnectionUser('cinatoken_gateway_runtime', 'rg2yy1ujj6s2'),
		'cinatoken_gateway_runtime.rg2yy1ujj6s2',
	);
	assert.throws(() => planetScaleConnectionUser('cinatoken_gateway_runtime', 'unsafe.branch'));
});
