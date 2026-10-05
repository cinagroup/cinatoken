import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenApi, type CinaTokenApi } from './api'
import type { PortalMe, WorkspaceContext } from './contracts'
import { CinaTokenSessionController } from './session'
import { deferred, testUser, testWorkspaceContext } from './test-fixtures'

function testApi(overrides: Partial<CinaTokenApi> = {}): CinaTokenApi {
	return {
		...createCinaTokenApi(),
		me: async () => testUser,
		workspaces: async () => testWorkspaceContext(),
		logout: async () => undefined,
		switchWorkspace: async (id) => testWorkspaceContext(id),
		...overrides,
	}
}

test('session refresh establishes the server identity and authorized workspace together', async () => {
	let invalidations = 0
	const session = new CinaTokenSessionController(testApi(), () => {
		invalidations += 1
	})
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'authenticated')
	assert.equal(session.getSnapshot().user?.userId, testUser.userId)
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:alice'
	)
	assert.equal(invalidations, 1)
})

test('transient API and malformed response failures preserve an established identity', async () => {
	let failed = false
	const api = testApi({
		me: async () => {
			if (failed) throw new CinaTokenApiError('Unavailable', 503, 'http')
			return testUser
		},
	})
	const session = new CinaTokenSessionController(api)
	await session.refresh()
	failed = true
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'authenticated')
	assert.equal(session.getSnapshot().user, testUser)
	assert.equal(session.getSnapshot().error, 'session_unavailable')
})

test('an explicit unauthorized check clears identity and account data', async () => {
	let failed = false
	let invalidations = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				if (failed) throw new CinaTokenApiError('Unauthorized', 401, 'http')
				return testUser
			},
		}),
		() => {
			invalidations += 1
		}
	)
	await session.refresh()
	failed = true
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'unauthenticated')
	assert.equal(session.getSnapshot().user, null)
	assert.equal(session.getSnapshot().workspaceContext, null)
	assert.equal(invalidations, 2)
})

test('a late session check cannot resurrect identity after logout', async () => {
	const identity = deferred<PortalMe>()
	const workspaces = deferred<WorkspaceContext>()
	const session = new CinaTokenSessionController(
		testApi({
			me: () => identity.promise,
			workspaces: () => workspaces.promise,
		})
	)
	const refresh = session.refresh()
	await session.logout()
	identity.resolve(testUser)
	workspaces.resolve(testWorkspaceContext())
	await refresh
	assert.equal(session.getSnapshot().status, 'unauthenticated')
	assert.equal(session.getSnapshot().user, null)
})

test('failed logout preserves identity and reports failure instead of claiming server revocation', async () => {
	const session = new CinaTokenSessionController(
		testApi({
			logout: async () => {
				throw new CinaTokenApiError('Unavailable', 503, 'http')
			},
		})
	)
	await session.refresh()
	await assert.rejects(session.logout())
	assert.equal(session.getSnapshot().user, testUser)
	assert.equal(session.getSnapshot().isLoggingOut, false)
	assert.equal(session.getSnapshot().error, 'logout_failed')
})

test('workspace switch hides the old scope and clears account cache before changing the cookie', async () => {
	const order: string[] = []
	const changed = deferred<WorkspaceContext>()
	const session = new CinaTokenSessionController(
		testApi({
			switchWorkspace: async () => {
				order.push('server')
				return changed.promise
			},
		}),
		() => {
			order.push('cache')
		}
	)
	await session.refresh()
	order.length = 0
	const oldVersion = session.getSnapshot().scopeVersion
	const switching = session.switchWorkspace('workspace:team')
	assert.equal(session.getSnapshot().isSwitchingWorkspace, true)
	assert.ok(session.getSnapshot().scopeVersion > oldVersion)
	await Promise.resolve()
	assert.deepEqual(order, ['cache', 'server'])
	changed.resolve(testWorkspaceContext('workspace:team'))
	await switching
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'workspace:team'
	)
})

test('workspace changes are serialized and cannot create out-of-order cookie preferences', async () => {
	let writes = 0
	const changed = deferred<WorkspaceContext>()
	const session = new CinaTokenSessionController(
		testApi({
			switchWorkspace: async () => {
				writes += 1
				return changed.promise
			},
		})
	)
	await session.refresh()
	const first = session.switchWorkspace('workspace:team')
	await session.switchWorkspace('personal:alice')
	await Promise.resolve()
	assert.equal(writes, 1)
	changed.resolve(testWorkspaceContext('workspace:team'))
	await first
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'workspace:team'
	)
})

test('failed switch re-reads the server cookie instead of restoring a possibly stale workspace', async () => {
	let selected = 'personal:alice'
	const session = new CinaTokenSessionController(
		testApi({
			workspaces: async () => testWorkspaceContext(selected),
			switchWorkspace: async (id) => {
				selected = id
				throw new CinaTokenApiError('Timed out', 0, 'timeout')
			},
		})
	)
	await session.refresh()
	await assert.rejects(session.switchWorkspace('workspace:team'))
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'workspace:team'
	)
	assert.equal(session.getSnapshot().status, 'authenticated')
	assert.equal(session.getSnapshot().error, 'workspace_switch_failed')
})

test('unknown workspace ids are rejected before any server preference write', async () => {
	let writes = 0
	const session = new CinaTokenSessionController(
		testApi({
			switchWorkspace: async (id) => {
				writes += 1
				return testWorkspaceContext(id)
			},
		})
	)
	await session.refresh()
	await assert.rejects(session.switchWorkspace('workspace:unknown'))
	assert.equal(writes, 0)
})

test('cross-tab cookie changes hide and invalidate the old scope before revalidation', async () => {
	let blocked = false
	const identity = deferred<PortalMe>()
	const order: string[] = []
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				if (blocked) {
					order.push('server')
					return identity.promise
				}
				return testUser
			},
		}),
		() => {
			order.push('cache')
		}
	)
	await session.refresh()
	order.length = 0
	blocked = true
	const reconciliation = session.revalidateScope()
	assert.equal(session.getSnapshot().status, 'loading')
	await Promise.resolve()
	assert.deepEqual(order, ['cache', 'server'])
	identity.resolve(testUser)
	await reconciliation
	assert.equal(session.getSnapshot().status, 'authenticated')
})

test('workspace access denial preserves authenticated identity but removes unauthorized workspace data', async () => {
	let denied = false
	const session = new CinaTokenSessionController(
		testApi({
			workspaces: async () => {
				if (denied) throw new CinaTokenApiError('Workspace denied', 403, 'http')
				return testWorkspaceContext()
			},
		})
	)
	await session.refresh()
	denied = true
	await session.refresh()
	assert.equal(session.getSnapshot().user, testUser)
	assert.equal(session.getSnapshot().workspaceContext, null)
	assert.equal(session.getSnapshot().status, 'unavailable')
})

test('focus and popup revalidation coalesce so they cannot cancel one another', async () => {
	const identity = deferred<PortalMe>()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return identity.promise
			},
		})
	)
	const first = session.refresh()
	const second = session.refresh()
	assert.equal(first, second)
	identity.resolve(testUser)
	await Promise.all([first, second])
	assert.equal(reads, 1)
	assert.equal(session.getSnapshot().status, 'authenticated')
})

test('effect cleanup allows StrictMode setup to start a fresh session check', async () => {
	const firstIdentity = deferred<PortalMe>()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				if (reads === 1) return firstIdentity.promise
				return testUser
			},
		})
	)
	const first = session.refresh()
	session.dispose()
	await session.refresh()
	assert.equal(reads, 2)
	assert.equal(session.getSnapshot().status, 'authenticated')
	firstIdentity.resolve({ ...testUser, userId: 'stale-user' })
	await first
	assert.equal(session.getSnapshot().user?.userId, testUser.userId)
})

function contextForUser(userId: string, workspaceId: string): WorkspaceContext {
	const workspace = {
		...testWorkspaceContext().currentWorkspace,
		id: workspaceId,
		personalOwnerUserId: userId,
	}
	return {
		workspaces: [workspace],
		currentWorkspace: workspace,
		preferredWorkspaceAvailable: true,
	}
}

test('workspace switch sends the starting workspace as the server precondition', async () => {
	const session = new CinaTokenSessionController(
		testApi({
			switchWorkspace: async (id, options) => {
				assert.equal(options?.expectedWorkspaceId, 'personal:alice')
				assert.equal(options?.expectedUserId, testUser.userId)
				return testWorkspaceContext(id)
			},
		})
	)
	await session.refresh()
	await session.switchWorkspace('workspace:team')
})

test('remote workspace signals queued during a switch are reconciled once before showing its result', async () => {
	const response = deferred<WorkspaceContext>()
	let reads = 0
	let serverWorkspace = testWorkspaceContext()
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return testUser
			},
			workspaces: async () => serverWorkspace,
			switchWorkspace: async () => response.promise,
		})
	)
	await session.refresh()
	const switching = session.switchWorkspace('workspace:team')
	await Promise.resolve()
	// Another tab selects Personal after the pending PUT captured its own older result.
	serverWorkspace = testWorkspaceContext('personal:alice')
	await session.revalidateScope()
	await session.revalidateScope()
	assert.equal(reads, 1)
	response.resolve(testWorkspaceContext('workspace:team'))
	await switching
	assert.equal(reads, 2)
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:alice'
	)
	assert.equal(session.getSnapshot().isSwitchingWorkspace, false)
})

test('a different-user login queued during a switch replaces both identity and workspace from the server', async () => {
	const response = deferred<WorkspaceContext>()
	let serverUser = testUser
	let serverWorkspace = testWorkspaceContext()
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => serverUser,
			workspaces: async () => serverWorkspace,
			switchWorkspace: async () => response.promise,
		})
	)
	await session.refresh()
	const switching = session.switchWorkspace('workspace:team')
	await Promise.resolve()
	serverUser = { ...testUser, userId: 'user:bob', subject: 'cinaauth:bob' }
	serverWorkspace = contextForUser(serverUser.userId, 'personal:bob')
	await session.revalidateScope()
	const visible: string[] = []
	const unsubscribe = session.subscribe(() => {
		const state = session.getSnapshot()
		if (state.status === 'authenticated' && !state.isSwitchingWorkspace)
			visible.push(
				`${state.user?.userId}|${state.workspaceContext?.currentWorkspace.id}`
			)
	})
	response.resolve(testWorkspaceContext('workspace:team'))
	await switching
	unsubscribe()
	assert.deepEqual(visible, ['user:bob|personal:bob'])
	assert.equal(session.getSnapshot().user?.userId, 'user:bob')
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:bob'
	)
})

test('failed switch merges queued login signals into its existing cookie reconciliation', async () => {
	const response = deferred<WorkspaceContext>()
	let serverUser = testUser
	let serverWorkspace = testWorkspaceContext()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return serverUser
			},
			workspaces: async () => serverWorkspace,
			switchWorkspace: async () => response.promise,
		})
	)
	await session.refresh()
	const switching = session.switchWorkspace('workspace:team')
	await Promise.resolve()
	serverUser = { ...testUser, userId: 'user:bob', subject: 'cinaauth:bob' }
	serverWorkspace = contextForUser(serverUser.userId, 'personal:bob')
	await session.revalidateScope()
	response.reject(
		new CinaTokenApiError('Workspace changed', 409, 'workspace-mismatch')
	)
	await assert.rejects(switching)
	assert.equal(reads, 2)
	assert.equal(session.getSnapshot().user?.userId, 'user:bob')
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:bob'
	)
})

test('failed logout consumes queued signals and ends with the latest server identity', async () => {
	const response = deferred<void>()
	let serverUser = testUser
	let serverWorkspace = testWorkspaceContext()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return serverUser
			},
			workspaces: async () => serverWorkspace,
			logout: async () => response.promise,
		})
	)
	await session.refresh()
	const logout = session.logout()
	await Promise.resolve()
	serverUser = { ...testUser, userId: 'user:bob', subject: 'cinaauth:bob' }
	serverWorkspace = contextForUser(serverUser.userId, 'personal:bob')
	await session.revalidateScope()
	response.reject(new CinaTokenApiError('Unavailable', 503, 'http'))
	await assert.rejects(logout)
	assert.equal(reads, 2)
	assert.equal(session.getSnapshot().user?.userId, 'user:bob')
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:bob'
	)
	assert.equal(session.getSnapshot().isLoggingOut, false)
})

test('successful logout without a queued signal never performs a session-restoring read', async () => {
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return testUser
			},
		})
	)
	await session.refresh()
	await session.logout()
	assert.equal(reads, 1)
	assert.equal(session.getSnapshot().status, 'unauthenticated')
	assert.equal(session.getSnapshot().user, null)
})

test('a queued signal after successful logout cannot resurrect a server-revoked identity', async () => {
	const response = deferred<void>()
	let revoked = false
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				if (revoked) throw new CinaTokenApiError('Unauthorized', 401, 'http')
				return testUser
			},
			logout: async () => response.promise,
		})
	)
	await session.refresh()
	const logout = session.logout()
	await Promise.resolve()
	await session.revalidateScope()
	revoked = true
	response.resolve()
	await logout
	assert.equal(session.getSnapshot().status, 'unauthenticated')
	assert.equal(session.getSnapshot().user, null)
})

test('successful logout accepts a subsequent different login only after a fresh server check', async () => {
	const response = deferred<void>()
	let serverUser = testUser
	let serverWorkspace = testWorkspaceContext()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				return serverUser
			},
			workspaces: async () => serverWorkspace,
			logout: async () => response.promise,
		})
	)
	await session.refresh()
	const logout = session.logout()
	await Promise.resolve()
	serverUser = { ...testUser, userId: 'user:bob', subject: 'cinaauth:bob' }
	serverWorkspace = contextForUser(serverUser.userId, 'personal:bob')
	await session.revalidateScope()
	response.resolve()
	await logout
	assert.equal(reads, 2)
	assert.equal(session.getSnapshot().user?.userId, 'user:bob')
	assert.equal(
		session.getSnapshot().workspaceContext?.currentWorkspace.id,
		'personal:bob'
	)
})

test('clear and dispose discard queued signals and ignore late mutation responses', async () => {
	for (const interrupt of ['clear', 'dispose'] as const) {
		const response = deferred<WorkspaceContext>()
		let reads = 0
		const session = new CinaTokenSessionController(
			testApi({
				me: async () => {
					reads += 1
					return testUser
				},
				switchWorkspace: async () => response.promise,
			})
		)
		await session.refresh()
		const switching = session.switchWorkspace('workspace:team')
		await Promise.resolve()
		await session.revalidateScope()
		session[interrupt]()
		response.resolve(testWorkspaceContext('workspace:team'))
		await switching
		assert.equal(reads, 1)
		assert.notEqual(
			session.getSnapshot().workspaceContext?.currentWorkspace.id,
			'workspace:team'
		)
		if (interrupt === 'clear') assert.equal(session.getSnapshot().user, null)
	}
})

test('dispose during queued logout reconciliation cannot restore a late server identity', async () => {
	const logoutResponse = deferred<void>()
	const identity = deferred<PortalMe>()
	const reconciliationStarted = deferred<void>()
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads += 1
				if (reads === 1) return testUser
				reconciliationStarted.resolve()
				return identity.promise
			},
			logout: async () => logoutResponse.promise,
		})
	)
	await session.refresh()
	const logout = session.logout()
	await Promise.resolve()
	await session.revalidateScope()
	logoutResponse.resolve()
	await reconciliationStarted.promise
	assert.equal(reads, 2)
	session.dispose()
	identity.resolve(testUser)
	await logout
	assert.equal(session.getSnapshot().user, null)
})

test('an unavailable check after successful logout cannot restore an uncertain identity', async () => {
	const response = deferred<void>()
	let unavailable = false
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				if (unavailable) throw new CinaTokenApiError('Unavailable', 503, 'http')
				return testUser
			},
			logout: async () => response.promise,
		})
	)
	await session.refresh()
	const logout = session.logout()
	await Promise.resolve()
	await session.revalidateScope()
	unavailable = true
	response.resolve()
	await logout
	assert.equal(session.getSnapshot().status, 'unavailable')
	assert.equal(session.getSnapshot().user, null)
	assert.equal(session.getSnapshot().workspaceContext, null)
})

test('capabilities and authoritative workspace security fields invalidate the old account scope', async () => {
	for (const field of [
		'capabilities',
		'organizationRoles',
		'personalOwnerUserId',
		'organizationId',
	] as const) {
		let serverUser = testUser
		let context = testWorkspaceContext()
		let invalidations = 0
		const session = new CinaTokenSessionController(
			testApi({ me: async () => serverUser, workspaces: async () => context }),
			() => {
				invalidations += 1
			}
		)
		await session.refresh()
		const version = session.getSnapshot().scopeVersion
		if (field === 'capabilities')
			serverUser = { ...testUser, capabilities: ['account.read'] }
		else {
			const currentWorkspace = { ...context.currentWorkspace }
			if (field === 'organizationRoles')
				currentWorkspace.organizationRoles = ['billing_admin']
			if (field === 'personalOwnerUserId')
				currentWorkspace.personalOwnerUserId = 'user:other'
			if (field === 'organizationId')
				currentWorkspace.organizationId = 'organization:other'
			context = { ...context, currentWorkspace }
		}
		await session.refresh()
		assert.ok(session.getSnapshot().scopeVersion > version, field)
		assert.equal(invalidations, 2, field)
	}
})

test('permission array reordering and display-only changes do not reset account data', async () => {
	let serverUser = testUser
	let context = testWorkspaceContext()
	let invalidations = 0
	const session = new CinaTokenSessionController(
		testApi({ me: async () => serverUser, workspaces: async () => context }),
		() => {
			invalidations += 1
		}
	)
	await session.refresh()
	const version = session.getSnapshot().scopeVersion
	serverUser = {
		...testUser,
		email: 'updated@example.test',
		capabilities: [...testUser.capabilities].reverse(),
	}
	context = {
		...context,
		currentWorkspace: { ...context.currentWorkspace, name: 'Renamed' },
	}
	await session.refresh()
	assert.equal(session.getSnapshot().scopeVersion, version)
	assert.equal(invalidations, 1)
})

test('session bootstrap discovers identity before requesting its authorized workspace', async () => {
	const identity = deferred<PortalMe>()
	const reads: string[] = []
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => {
				reads.push('identity')
				return identity.promise
			},
			workspaces: async (options) => {
				assert.equal(options?.expectedUserId, testUser.userId)
				reads.push('workspace')
				return testWorkspaceContext('workspace:team')
			},
		})
	)
	const refreshing = session.refresh()
	await Promise.resolve()
	assert.deepEqual(reads, ['identity'])
	identity.resolve(testUser)
	await refreshing
	assert.deepEqual(reads, ['identity', 'workspace'])
	assert.equal(session.getSnapshot().status, 'authenticated')
})

test('a cookie identity change between session reads discards even an unchanged workspace', async () => {
	let changed = false
	let invalidations = 0
	let reads = 0
	const session = new CinaTokenSessionController(
		testApi({
			workspaces: async (options) => {
				assert.equal(options?.expectedUserId, testUser.userId)
				reads += 1
				if (changed)
					throw new CinaTokenApiError(
						'User changed',
						409,
						'user-mismatch',
						'user_mismatch'
					)
				return testWorkspaceContext('workspace:team')
			},
		}),
		() => {
			invalidations += 1
		}
	)
	await session.refresh()
	const before = session.getSnapshot().scopeVersion
	changed = true
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'unavailable')
	assert.equal(session.getSnapshot().workspaceContext, null)
	assert.equal(session.getSnapshot().scopeVersion, before + 1)
	assert.equal(session.getSnapshot().error, 'session_unavailable')
	assert.equal(reads, 2)
	assert.equal(invalidations, 2)
})

test('a rejected workspace write reconciles the new user once without replaying the write', async () => {
	let currentUser = testUser
	let currentWorkspace = testWorkspaceContext()
	let writes = 0
	const nextUser = { ...testUser, userId: 'user:bob', subject: 'cinaauth:bob' }
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => currentUser,
			workspaces: async (options) => {
				assert.equal(options?.expectedUserId, currentUser.userId)
				return currentWorkspace
			},
			switchWorkspace: async (_id, options) => {
				assert.equal(options?.expectedUserId, testUser.userId)
				assert.equal(options?.expectedWorkspaceId, 'personal:alice')
				writes += 1
				currentUser = nextUser
				currentWorkspace = contextForUser(nextUser.userId, 'workspace:team')
				throw new CinaTokenApiError(
					'User changed',
					409,
					'user-mismatch',
					'user_mismatch'
				)
			},
		})
	)
	await session.refresh()
	await assert.rejects(
		session.switchWorkspace('workspace:team'),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'user-mismatch'
	)
	assert.equal(writes, 1)
	assert.equal(session.getSnapshot().user?.userId, nextUser.userId)
	assert.equal(session.getSnapshot().status, 'authenticated')
	assert.equal(session.getSnapshot().error, null)
})

test('an abandoned identity discovery never dispatches a dependent workspace request', async () => {
	const identity = deferred<PortalMe>()
	let workspaceReads = 0
	const session = new CinaTokenSessionController(
		testApi({
			me: async () => identity.promise,
			workspaces: async () => {
				workspaceReads += 1
				return testWorkspaceContext()
			},
		})
	)
	const refreshing = session.refresh()
	session.clear()
	identity.resolve(testUser)
	await refreshing
	assert.equal(workspaceReads, 0)
	assert.equal(session.getSnapshot().status, 'unauthenticated')
})
