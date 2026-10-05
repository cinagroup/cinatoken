/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolAuditEntry, validToolAuditPage } from './tools-audit'
import { toolOverviewData, toolDetailData } from './tools-contracts'
import {
	toolEditorDefaults,
	toolEditorPayload,
	toolEditorFormSchema,
} from './tools-editor-form'
import {
	fixtureOverview,
	fixtureDetail,
	fixtureAudit,
	fixtureVersion,
	fixtureAuditId,
} from './tools-fixtures'
import { validateToolSave, toolReason, toolOp } from './tools-input'
import {
	decodeToolCursor,
	encodeToolToken,
	validToolVersion,
} from './tools-token'

test('all four families and ten engines project only safe ordinary state', () => {
	const raw = {
		...fixtureOverview(),
		secret: 'private',
		catalog: { apiKey: 'private' },
	}
	const first = raw.families[0] as (typeof raw.families)[0] & { apiKey: string }
	first.apiKey = 'private'
	const parsed = toolOverviewData.parse(raw)
	assert.equal(
		parsed.families.reduce((sum, family) => sum + family.providers.length, 0),
		10
	)
	assert.equal(JSON.stringify(parsed).includes('private'), false)
})
test('legacy/missing/default and invalid currency do not pretend foreign prices are USD', () => {
	const detail = fixtureDetail()
	assert.equal(toolDetailData.parse(detail).billingCurrency.source, 'missing')
	detail.billingCurrency = { value: null, source: 'unsupported' }
	detail.familyState.editable = false
	detail.familyState.editBlockedCode = 'invalid_currency'
	assert.equal(toolDetailData.parse(detail).billingCurrency.value, null)
	assert.equal(
		toolDetailData.safeParse({
			...detail,
			billingCurrency: { value: 'USD', source: 'invalid' },
		}).success,
		false
	)
})
test('family/provider and required credential sets are bound, not free text', () => {
	const detail = fixtureDetail()
	detail.provider = 'jina'
	assert.equal(toolDetailData.safeParse(detail).success, false)
	const ai = fixtureDetail('ai-detection')
	ai.configuration.credentials = [
		{ field: 'apiKey', required: true, configured: true },
	]
	assert.equal(toolDetailData.safeParse(ai).success, false)
	const overview = fixtureOverview()
	overview.families[1] = overview.families[0]
	assert.equal(toolOverviewData.safeParse(overview).success, false)
})
test('opaque version is canonical fixed metadata only and belongs to the exact family', () => {
	const value = fixtureVersion('web-search')
	assert.equal(validToolVersion(value, 'web-search'), true)
	assert.equal(validToolVersion(value, 'web-fetch'), false)
	const raw = JSON.parse(
		new TextDecoder().decode(
			Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
		)
	)
	raw.readSet[0].value = 'private'
	assert.equal(validToolVersion(encodeToolToken(raw), 'web-search'), false)
	assert.equal(validToolVersion(value + '=', 'web-search'), false)
})
test('price/loss projection and billing units reject unsafe numeric wire data', () => {
	const detail = fixtureDetail()
	detail.configuration.prices!.metered = Infinity
	assert.equal(toolDetailData.safeParse(detail).success, false)
	const loss = fixtureDetail()
	loss.configuration.isLossPricing = true
	assert.equal(toolDetailData.safeParse(loss).success, false)
	const ai = fixtureDetail('ai-detection')
	ai.configuration.billingUnitChars = 0
	assert.equal(toolDetailData.safeParse(ai).success, false)
})
test('editor preserves keep, requires explicit set/clear, audit reason and loss acknowledgement', () => {
	const detail = fixtureDetail(),
		values = toolEditorDefaults(detail)
	assert.equal(values.reason, '')
	assert.equal(toolEditorFormSchema.safeParse(values).success, false)
	values.reason = 'Review tariff'
	values.apiKeyOp = 'set'
	values.apiKey = '  private-fixture  '
	const payload = validateToolSave(
		detail,
		toolEditorPayload(detail, values, 'save', false)
	)
	assert.deepEqual(payload.credentials.apiKey, {
		op: 'set',
		value: 'private-fixture',
	})
	values.apiKeyOp = 'clear'
	assert.deepEqual(
		toolEditorPayload(detail, values, 'save_activate', false).credentials
			.apiKey,
		{ op: 'clear' }
	)
	values.charged = '0'
	assert.throws(() =>
		validateToolSave(detail, toolEditorPayload(detail, values, 'save', false))
	)
	assert.doesNotThrow(() =>
		validateToolSave(detail, toolEditorPayload(detail, values, 'save', true))
	)
	values.metered = '0.1234567'
	assert.equal(toolEditorFormSchema.safeParse(values).success, false)
})
test('Tencent editing keeps unavailable setting values without replacing them', () => {
	const detail = fixtureDetail('ai-detection')
	detail.settings!.region = {
		value: null,
		availability: 'redacted',
		source: 'configured',
	}
	const values = toolEditorDefaults(detail)
	values.reason = 'Change only prices'
	assert.deepEqual(toolEditorPayload(detail, values, 'save', false).settings, {
		billingUnitChars: 2000,
		region: { op: 'keep' },
		bizType: { op: 'keep' },
	})
	assert.equal(toolDetailData.parse(detail).settings?.region.value, null)
})
test('reason counts code points while credential updates retain their exact UTF16 bound', () => {
	assert.equal(toolReason.safeParse('😀'.repeat(600)).success, true)
	assert.equal(toolReason.safeParse('😀'.repeat(601)).success, false)
	assert.equal(
		toolOp(4096).safeParse({ op: 'set', value: '😀'.repeat(2048) }).success,
		true
	)
	assert.equal(
		toolOp(4096).safeParse({ op: 'set', value: '😀'.repeat(2049) }).success,
		false
	)
})
test('audit raw actor kind bounds apply before redaction and count Unicode code points', () => {
	const entry = fixtureAudit().entries[0]
	assert.equal(
		toolAuditEntry.safeParse({ ...entry, actorId: '😀'.repeat(617) }).success,
		true
	)
	assert.equal(
		toolAuditEntry.safeParse({ ...entry, actorId: 'x'.repeat(618) }).success,
		false
	)
	assert.equal(
		toolAuditEntry.safeParse({
			...entry,
			actorKind: 'admin_key',
			actorId: 'x'.repeat(600),
		}).success,
		true
	)
	assert.equal(
		toolAuditEntry.safeParse({
			...entry,
			actorKind: 'admin_key',
			actorId: 'sk-' + 'a'.repeat(598),
		}).success,
		false
	)
	assert.equal(
		toolAuditEntry.safeParse({ ...entry, reason: 'x'.repeat(601) }).success,
		false
	)
})
test('audit exact family cursor, one-microsecond descending order and last tuple are enforced', () => {
	const page = fixtureAudit(),
		entry = page.entries[0]
	page.entries = [
		{ ...entry, createdAt: '2026-10-01T00:00:00.123457Z' },
		{ ...entry, id: '00000000-0000-4000-8000-000000000002' },
	]
	assert.equal(validToolAuditPage(page, 'web-search', null), true)
	page.entries.reverse()
	assert.equal(validToolAuditPage(page, 'web-search', null), false)
	const cursor = encodeToolToken({
		v: 1,
		family: 'web-search',
		created_at: entry.createdAt,
		id: fixtureAuditId,
	})
	assert.equal(decodeToolCursor(cursor, 'web-fetch'), null)
	assert.equal(decodeToolCursor(cursor + '=', 'web-search'), null)
	assert.equal(
		validToolAuditPage(
			fixtureAudit(),
			'web-search',
			decodeToolCursor(cursor, 'web-search')
		),
		false
	)
	const full = fixtureAudit()
	full.entries = Array.from({ length: 20 }, (_, i) => ({
		...entry,
		id: `00000000-0000-4000-8000-${String(20 - i).padStart(12, '0')}`,
	}))
	full.next_cursor = encodeToolToken({
		v: 1,
		family: 'web-search',
		created_at: entry.createdAt,
		id: full.entries[19].id,
	})
	assert.equal(validToolAuditPage(full, 'web-search', null), true)
	full.next_cursor = cursor
	assert.equal(validToolAuditPage(full, 'web-search', null), true)
	full.next_cursor = encodeToolToken({
		v: 1,
		family: 'web-search',
		created_at: entry.createdAt,
		id: full.entries[0].id,
	})
	assert.equal(validToolAuditPage(full, 'web-search', null), false)
	full.next_cursor = null
	assert.equal(validToolAuditPage(full, 'web-search', null), true)
})
