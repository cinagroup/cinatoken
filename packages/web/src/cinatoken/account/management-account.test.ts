import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testUser, testWorkspace } from '../test-fixtures'
import {
	managementAccessRestriction,
	managementAccount,
} from './management-account'

const user = {
	...testUser,
	capabilities: [...testUser.capabilities, 'management_keys.manage'],
}

test('personal management requests require both capability and ownership', () => {
	const workspace = testWorkspace()
	assert.equal(managementAccessRestriction(testUser, workspace), 'capability')
	assert.equal(
		managementAccessRestriction(user, { ...workspace, role: 'admin' }),
		'owner'
	)
	assert.equal(
		managementAccessRestriction(user, {
			...workspace,
			personalOwnerUserId: 'other-user',
		}),
		'owner'
	)
	assert.equal(managementAccessRestriction(user, workspace), null)
	assert.deepEqual(managementAccount(workspace), {
		account_type: 'personal',
		personal_owner_user_id: testUser.userId,
		organization_id: null,
	})
})

test('organization workspace role never substitutes for the server organization role mapping', () => {
	const workspace = {
		...testWorkspace(),
		scopeType: 'organization' as const,
		organizationId: 'org-1',
		personalOwnerUserId: null,
		role: 'member' as const,
		organizationRoles: ['TenantDefinedFinanceAdmin'],
	}
	// Passing the request gate is not authorization; GET must succeed before actions are shown.
	assert.equal(managementAccessRestriction(user, workspace), null)
	assert.equal(
		managementAccessRestriction(user, {
			...workspace,
			role: 'admin',
			organizationRoles: [],
		}),
		null
	)
	assert.deepEqual(managementAccount(workspace), {
		account_type: 'organization',
		personal_owner_user_id: null,
		organization_id: 'org-1',
	})
	assert.equal(
		managementAccessRestriction(user, { ...workspace, organizationId: null }),
		'organization'
	)
})
