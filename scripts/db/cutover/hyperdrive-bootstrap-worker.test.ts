import assert from 'node:assert/strict';
import test from 'node:test';
import {
	generateBootstrapPassword,
	planetScaleConnectionUser,
} from './hyperdrive-bootstrap-worker';
import { adminAuditAccessPassed, adminKeyAuditAccessPassed, configAuditAccessPassed, configWriteMutexAccessPassed, runtimeRoleAccessPassed } from './hyperdrive-access-probe-worker';

test('runtime role inspection is mandatory and accepts only a verified restricted direct login', () => {
	assert.equal(runtimeRoleAccessPassed({ runtime_is_direct_login: true }), true);
	assert.equal(runtimeRoleAccessPassed({ runtime_is_direct_login: false }), false);
	assert.equal(runtimeRoleAccessPassed({}), false);
	assert.equal(runtimeRoleAccessPassed(undefined), false);
});

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

test('the Hyperdrive runtime probe requires Config audit INSERT and rejects every extra privilege', () => {
	const insertOnly = {
		config_change_audit_insert: true,
		config_change_audit_insert_grant_option: false,
		config_change_audit_select: false,
		config_change_audit_update: false,
		config_change_audit_delete: false,
		config_change_audit_truncate: false,
		config_change_audit_references: false,
		config_change_audit_trigger: false,
		config_change_audit_maintain: false,
		config_change_audit_column_select: false,
		config_change_audit_column_update: false,
		config_change_audit_column_references: false,
		config_change_audit_column_insert_grant_option: false,
	};

	assert.equal(configAuditAccessPassed(insertOnly), true);
	assert.equal(configAuditAccessPassed(undefined), false);
	assert.equal(configAuditAccessPassed({ ...insertOnly, config_change_audit_insert: false }), false);

	for (const privilege of Object.keys(insertOnly) as Array<keyof typeof insertOnly>) {
		if (privilege === 'config_change_audit_insert') continue;
		assert.equal(configAuditAccessPassed({ ...insertOnly, [privilege]: true }), false, privilege);
		assert.equal(configAuditAccessPassed({ ...insertOnly, [privilege]: undefined }), false, `${privilege} missing`);
	}
});

test('integration-key audit runtime access permits SELECT/INSERT and rejects mutation and delegated grants', () => {
	const permitted = { select: true, insert: true, update: false, delete: false, truncate: false, references: false,
		trigger: false, maintain: false, select_grant_option: false, insert_grant_option: false, column_update: false,
		column_references: false, column_select_grant_option: false, column_insert_grant_option: false };
	assert.equal(adminKeyAuditAccessPassed(permitted), true); assert.equal(adminKeyAuditAccessPassed(undefined), false);
	for (const [privilege, expected] of Object.entries(permitted)) {
		assert.equal(adminKeyAuditAccessPassed({ ...permitted, [privilege]: !expected }), false, privilege);
		const missing: Record<string, boolean> = { ...permitted }; delete missing[privilege];
		assert.equal(adminKeyAuditAccessPassed(missing), false, `${privilege} missing`);
	}
});

test('runtime authorization requires all three audit histories and rejects table or column privilege drift', () => {
	const allowed = { select: true, insert: true, update: false, delete: false, truncate: false, references: false,
		trigger: false, maintain: false, select_grant_option: false, insert_grant_option: false, column_update: false,
		column_references: false, column_select_grant_option: false, column_insert_grant_option: false };
	const row = { admin_access_key_audit_access: { ...allowed }, admin_shared_key_audit_access: { ...allowed }, config_group_audit_access: { ...allowed } };
	assert.equal(adminAuditAccessPassed(row), true);
	assert.equal(adminAuditAccessPassed(undefined), false);
	for (const table of ['admin_access_key_audit_access', 'admin_shared_key_audit_access', 'config_group_audit_access'] as const) {
		assert.equal(adminAuditAccessPassed({ ...row, [table]: undefined } as unknown as typeof row), false, `${table} missing`);
		for (const [privilege, expected] of Object.entries(allowed)) {
			assert.equal(adminAuditAccessPassed({ ...row, [table]: { ...allowed, [privilege]: !expected } }), false, `${table}.${privilege}`);
			const incomplete: Record<string, boolean> = { ...allowed };
			delete incomplete[privilege];
			assert.equal(adminAuditAccessPassed({ ...row, [table]: incomplete }), false, `${table}.${privilege} missing`);
		}
	}
});

test('configuration mutex requires the seeded singleton and SELECT/UPDATE(id), with no extra or delegated access', () => {
	const allowed = { select: true, update_id: true, singleton: true, insert: false, update: false,
		delete: false, truncate: false, references: false, trigger: false, maintain: false,
		select_grant_option: false, column_select_grant_option: false, column_insert: false,
		column_references: false, column_update_other: false, column_update_grant_option: false };
	assert.equal(configWriteMutexAccessPassed(allowed), true);
	assert.equal(configWriteMutexAccessPassed(undefined), false);
	for (const [privilege, expected] of Object.entries(allowed)) {
		assert.equal(configWriteMutexAccessPassed({ ...allowed, [privilege]: !expected }), false, privilege);
		const missing: Record<string, boolean> = { ...allowed }; delete missing[privilege];
		assert.equal(configWriteMutexAccessPassed(missing), false, `${privilege} missing`);
	}
});
