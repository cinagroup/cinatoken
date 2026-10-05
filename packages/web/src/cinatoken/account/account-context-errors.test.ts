/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../api'
import { byokErrorKey } from './byok/use-byok-manager'
import { guardrailErrorKey } from './guardrails/use-guardrails-manager'
import { nftErrorKey } from './nft/use-nft-manager'
import { presetAccessFailure, presetErrorKey } from './presets/preset-errors'
import { presetContextErrorKey } from './presets/use-presets-manager'
import {
	sharedKeyAccessFailure,
	sharedKeyErrorKey,
} from './shared-keys/use-shared-keys'
import { withdrawalErrorKey } from './withdraw/use-withdraw-manager'

test('Preset main alert retains identity rejection after a detail dialog closes', () => {
	const identity = new CinaTokenApiError('User changed', 409, 'user-mismatch')
	const resource = new CinaTokenApiError('Version changed', 409, 'http')
	// The retained access failure, list failure, or mutation failure can outlive its dialog.
	for (const errors of [
		[identity, null, null],
		[null, identity, null],
		[null, null, identity],
	])
		assert.equal(
			presetContextErrorKey(errors),
			'cinatoken.account.sessionChanged'
		)
	assert.equal(
		presetContextErrorKey([null, resource, null]),
		'cinatoken.presets.scopeHint'
	)
})

test('identity rejection stops account actions with a session message, preserving resource conflicts', () => {
	const identity = new CinaTokenApiError('User changed', 409, 'user-mismatch')
	const resource = new CinaTokenApiError('Resource changed', 409, 'http')
	const cases: [(error: unknown) => string, string, string][] = [
		[
			byokErrorKey,
			'cinatoken.account.sessionChanged',
			'cinatoken.account.byok.conflict',
		],
		[
			presetErrorKey,
			'cinatoken.account.sessionChanged',
			'cinatoken.presets.conflict',
		],
		[
			sharedKeyErrorKey,
			'cinatoken.account.sessionChanged',
			'cinatoken.account.sharedKeys.duplicate',
		],
		[guardrailErrorKey, 'sessionChanged', 'conflict'],
		[nftErrorKey, 'sessionChanged', 'conflict'],
		[withdrawalErrorKey, 'sessionChanged', 'conflict'],
	]
	for (const [key, expectedIdentity, expectedResource] of cases) {
		assert.equal(key(identity), expectedIdentity)
		assert.equal(key(resource), expectedResource)
	}
	for (const blocks of [presetAccessFailure, sharedKeyAccessFailure]) {
		assert.equal(blocks(identity), true)
		assert.equal(blocks(resource), false)
	}
})
