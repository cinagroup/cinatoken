/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
	userDetailSchema,
	userDetailKeySchema,
} from '../user-detail/user-detail-contracts'
import {
	buildUserDetailPatches,
	draftFromUser,
} from '../user-detail/user-detail-domain'
import { adminUserListRowSchema } from '../users/users-contracts'
import { emptyUserCreateDraft, normalizeUserCreate } from '../users/users-input'
import { RateLimitEditor, RateLimitSummary } from './RateLimitEditor'
import {
	gatewayKeyDetailSchema,
	gatewayKeyRowSchema,
} from './gateway-key-contracts'
import {
	gatewayKeyCreateInput,
	gatewayKeyEditInput,
	type GatewayKeyEditForm,
} from './gateway-key-input'
import { adminGatewayKeyMessages } from './messages'
import {
	rateLimitEquals,
	rateLimitPatch,
	rateLimitReadSchema,
} from './rate-limit'

const userWire = {
	id: 'f2b74bc0-32f3-4613-aea7-96f723d08e12',
	email: 'person@example.test',
	external_system: null,
	external_user_id: null,
	budget_max: 10,
	budget_base: 10,
	budget_spent: 3,
	budget_period: 'monthly',
	budget_reset_at: null,
	status: 'active',
	metadata: null,
	charged_cost_factors: null,
	created_at: '2026-09-28T00:00:00.000Z',
	updated_at: '2026-09-28T01:00:00.000Z',
	wallet_granted: 20,
	wallet_spent: 4,
	wallet_balance: 16,
}
const keyWire = {
	id: 'key-1',
	key: 'sk-…',
	user_id: userWire.id,
	workspace_id: 'personal:' + userWire.id,
	user_email: userWire.email,
	name: 'Team key',
	budget_max: 10,
	budget_base: 10,
	budget_spent: 3,
	budget_period: 'monthly',
	budget_reset_at: null,
	status: 'active',
	created_at: userWire.created_at,
	updated_at: userWire.updated_at,
	profile_revision: 'sha256:' + 'a'.repeat(64),
	metadata_preview: null,
	metadata_unavailable: false,
	metadata_raw: null,
	last_used_at: null,
}
const edit: GatewayKeyEditForm = {
	name: 'Team key',
	status: 'active',
	statusConfirmed: false,
	metadataMode: 'unchanged',
	metadata: '',
	reason: 'Operator request',
}

test('rate-limit reads distinguish unavailable, unlimited and zero without retaining unknown provider fields', () => {
	assert.equal(rateLimitReadSchema.parse(undefined), undefined)
	for (const value of [null, {}])
		assert.equal(rateLimitReadSchema.parse(value), null)
	for (const rpm of [0, 1, 60, Number.MAX_SAFE_INTEGER])
		assert.deepEqual(rateLimitReadSchema.parse({ rpm }), { rpm })
	for (const raw of [
		{ rpm: -1 },
		{ rpm: 0.5 },
		{ rpm: Infinity },
		{ rpm: Number.MAX_SAFE_INTEGER + 1 },
		{ rpm: '20' },
		{ tpm: 40 },
		{ rpm: 10, api_key: 'PRIVATE' },
		'PRIVATE',
		[],
	])
		assert.equal(rateLimitReadSchema.parse(raw), undefined)
})
test('rate-limit patch is explicit, preserves unknown responses, and compares unlimited separately from zero', () => {
	for (const before of [undefined, null, { rpm: 0 }, { rpm: 25 }])
		assert.equal(rateLimitPatch(before, 'unchanged', 'invalid'), undefined)
	assert.equal(rateLimitPatch(null, 'unlimited'), undefined)
	assert.equal(rateLimitPatch(undefined, 'unlimited'), null)
	assert.equal(rateLimitPatch({ rpm: 0 }, 'unlimited'), null)
	assert.deepEqual(rateLimitPatch(undefined, 'limited', '0'), { rpm: 0 })
	assert.equal(rateLimitPatch({ rpm: 0 }, 'limited', '00'), undefined)
	assert.deepEqual(rateLimitPatch(null, 'limited', '25'), { rpm: 25 })
	assert.equal(rateLimitEquals(undefined, null), false)
	assert.equal(rateLimitEquals({ rpm: 0 }, null), false)
})
test('rate-limit form input rejects rounding, signs, exponent notation, fractional and unsafe values', () => {
	assert.deepEqual(
		rateLimitPatch(null, 'limited', String(Number.MAX_SAFE_INTEGER)),
		{ rpm: Number.MAX_SAFE_INTEGER }
	)
	for (const raw of [
		'',
		'-1',
		'+1',
		'0.5',
		'1e3',
		'Infinity',
		'NaN',
		'9007199254740992',
		'1'.repeat(80),
	])
		assert.throws(() => rateLimitPatch(null, 'limited', raw))
})
test('all management DTOs retain valid limits but preserve legacy missing or invalid values as unavailable', () => {
	for (const raw of [
		undefined,
		null,
		{ rpm: 0 },
		{ rpm: 12 },
		{ rpm: 12, token: 'PRIVATE' },
	]) {
		const expected = rateLimitReadSchema.parse(raw)
		const user = userDetailSchema.parse({ ...userWire, rate_limit: raw })
		const list = adminUserListRowSchema.parse({
			...userWire,
			rate_limit: raw,
			active_keys_count: 1,
			keys_count: 1,
		})
		const key = gatewayKeyRowSchema.parse({ ...keyWire, rate_limit: raw })
		const detail = gatewayKeyDetailSchema.parse({ ...keyWire, rate_limit: raw })
		const child = userDetailKeySchema.parse({ ...keyWire, rate_limit: raw })
		for (const row of [user, list, key, detail, child]) {
			assert.deepEqual(row.rate_limit, expected)
			assert.doesNotMatch(JSON.stringify(row), /PRIVATE/u)
		}
	}
})
test('user RPM-only edits require an audit reason and do not mutate period, spending or permanent wallet', () => {
	const user = userDetailSchema.parse({ ...userWire, rate_limit: null })
	const draft = draftFromUser(user)
	assert.equal(buildUserDetailPatches(user, draft).profile, null)
	draft.rateLimitMode = 'limited'
	draft.rateLimitRpm = '0'
	assert.throws(() => buildUserDetailPatches(user, draft))
	draft.rateLimitReason = 'Pause metered calls'
	assert.deepEqual(buildUserDetailPatches(user, draft), {
		profile: { rate_limit: { rpm: 0 }, reason: 'Pause metered calls' },
		budget: null,
	})
	for (const reason of ['', 'x'.repeat(257), 'line\nbreak'])
		assert.throws(() =>
			buildUserDetailPatches(user, { ...draft, rateLimitReason: reason })
		)
})
test('unrelated user edits never send RPM even for old responses, and explicit unlimited sends null', () => {
	const legacy = userDetailSchema.parse(userWire),
		draft = draftFromUser(legacy)
	draft.email = 'new@example.test'
	const profile = buildUserDetailPatches(legacy, draft).profile
	assert.deepEqual(profile, {
		email: 'new@example.test',
		reason: 'gwui:user-profile',
	})
	const known = userDetailSchema.parse({ ...userWire, rate_limit: { rpm: 0 } })
	assert.deepEqual(
		buildUserDetailPatches(known, {
			...draftFromUser(known),
			rateLimitMode: 'unlimited',
			rateLimitReason: 'Remove user cap',
		}),
		{ profile: { rate_limit: null, reason: 'Remove user cap' }, budget: null }
	)
	const same = {
		...draftFromUser(known),
		rateLimitMode: 'limited' as const,
		rateLimitRpm: '0',
	}
	assert.deepEqual(buildUserDetailPatches(known, same), {
		profile: null,
		budget: null,
	})
})
test('Key limit edits retain the exact profile revision and audit reason; blank or unchanged cannot clear limits', () => {
	const detail = gatewayKeyDetailSchema.parse({
		...keyWire,
		rate_limit: { rpm: 20 },
	})
	assert.equal('rate_limit' in gatewayKeyEditInput(detail, edit), false)
	const limited = gatewayKeyEditInput(detail, {
		...edit,
		rateLimitMode: 'limited',
		rateLimitRpm: '0',
	})
	assert.equal(limited.expected_revision, keyWire.profile_revision)
	assert.equal(limited.reason, edit.reason)
	assert.deepEqual(limited.rate_limit, { rpm: 0 })
	assert.equal(
		gatewayKeyEditInput(detail, { ...edit, rateLimitMode: 'unlimited' })
			.rate_limit,
		null
	)
	assert.throws(() =>
		gatewayKeyEditInput(detail, {
			...edit,
			rateLimitMode: 'limited',
			rateLimitRpm: '',
		})
	)
	assert.throws(() =>
		gatewayKeyEditInput(detail, {
			...edit,
			rateLimitMode: 'limited',
			rateLimitRpm: '1',
			reason: '',
		})
	)
	assert.throws(() =>
		gatewayKeyEditInput(
			{ ...detail, profile_revision: 'old' },
			{ ...edit, rateLimitMode: 'limited', rateLimitRpm: '1' }
		)
	)
})
async function render(
	locale: keyof typeof adminGatewayKeyMessages,
	node: ReactNode
): Promise<string> {
	const instance = createInstance()
	await instance.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminGatewayKeys: adminGatewayKeyMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(I18nextProvider, { i18n: instance }, node)
	)
}
test('four-language summaries keep missing, unlimited and zero distinct and describe both independent layers', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = adminGatewayKeyMessages[locale]
		const missing = await render(
			locale,
			createElement(RateLimitSummary, { value: undefined, layer: 'user' })
		)
		assert.ok(missing.includes(messages.rateLimitUnknown))
		assert.ok(!missing.includes(messages.rateLimitUnlimited))
		const unlimited = await render(
			locale,
			createElement(RateLimitSummary, { value: null, layer: 'key' })
		)
		assert.ok(unlimited.includes(messages.rateLimitUnlimited))
		const blocked = await render(
			locale,
			createElement(RateLimitSummary, {
				value: { rpm: 0 },
				layer: 'user',
				hint: true,
			})
		)
		assert.ok(blocked.includes('0'))
		assert.ok(blocked.includes(messages.rateLimitUserHint))
		assert.ok(!blocked.includes(messages.rateLimitUnknown))
	}
})
test('shared shadcn editor preserves explicit unchanged default, disabled state, accessible fields and integer bounds', async () => {
	const html = await render(
		'en',
		createElement(RateLimitEditor, {
			current: undefined,
			layer: 'key',
			mode: 'limited',
			rpm: '0',
			disabled: true,
			invalid: true,
			onMode: () => {},
			onRpm: () => {},
		})
	)
	assert.match(html, /fieldset[^>]*disabled/u)
	assert.match(html, /input[^>]*inputMode="numeric"/iu)
	assert.match(html, /maxLength="16"/iu)
	assert.match(html, /aria-invalid="true"/u)
	assert.match(html, /for="[^"]+-rpm"/u)
	assert.match(html, /9007199254740991/u)
	const unchanged = await render(
		'en',
		createElement(RateLimitEditor, {
			current: null,
			layer: 'user',
			mode: 'unchanged',
			rpm: '',
			disabled: false,
			onMode: () => {},
			onRpm: () => {},
		})
	)
	assert.match(unchanged, /value="unchanged" selected/u)
	assert.doesNotMatch(unchanged, /<input/u)
})

test('create builders do not invent RPM writes for endpoints that do not support the field', () => {
	const userDraft = {
		...emptyUserCreateDraft,
		email: 'new@example.test',
		rateLimitMode: 'limited',
		rateLimitRpm: '0',
	}
	assert.equal('rate_limit' in normalizeUserCreate(userDraft), false)
	const keyDraft = {
		mode: 'existing' as const,
		userId: userWire.id,
		email: '',
		externalSystem: '',
		externalUserId: '',
		name: 'Key',
		metadata: '',
		reason: 'Create key',
		rateLimitMode: 'limited',
		rateLimitRpm: '0',
	}
	assert.equal('rate_limit' in gatewayKeyCreateInput(keyDraft), false)
})
