import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertProvisioningPassword,
	GATEWAY_MIGRATOR_ROLE,
	GATEWAY_RUNTIME_ROLE,
	GATEWAY_SCHEMA,
} from './provision-postgres-roles';

test('gateway PostgreSQL identities stay in the dedicated namespace', () => {
	assert.equal(GATEWAY_SCHEMA, 'cinatoken_gateway');
	assert.equal(GATEWAY_MIGRATOR_ROLE, 'cinatoken_gateway_migrator');
	assert.equal(GATEWAY_RUNTIME_ROLE, 'cinatoken_gateway_runtime');
});

test('role provisioning refuses missing or short passwords', () => {
	assert.throws(() => assertProvisioningPassword('TEST_PASSWORD', undefined), /at least 24 characters/);
	assert.throws(() => assertProvisioningPassword('TEST_PASSWORD', 'short'), /at least 24 characters/);
	assert.equal(
		assertProvisioningPassword('TEST_PASSWORD', 'this-is-a-long-test-password'),
		'this-is-a-long-test-password',
	);
});
