import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { serializeUserActivityCsv } from '../../../../../core/src/lib/activity-csv'
import { activityDataSchema } from '../../activity-contracts'
import { readActivityCsvResponse } from '../../activity-csv'
import { requestChargeSplitMessages } from '../../admin/request-logs/charge-split-messages'
import { createCinaTokenApi } from '../../api'
import { ActivityChargeSplit } from './ActivityChargeSplit'
import { ActivityRequestList } from './ActivityRequestList'
import {
	activityChargeData,
	activityChargeLog,
} from './activity-charge-fixtures'
import { activityMessages } from './messages'

const options = { expectedWorkspaceId: activityChargeData.workspaceId }
function response(
	body: string,
	allocation: string | null = 'v1',
	count = 1
): Response {
	const headers: Record<string, string> = {
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition':
			'attachment; filename="cinatoken-activity-2026-10-18.csv"',
		'X-CinaToken-Workspace-Id': encodeURIComponent(options.expectedWorkspaceId),
		'X-CinaToken-Export-Count': String(count),
		'X-CinaToken-Export-Total': String(count),
		'X-CinaToken-Export-Truncated': 'false',
		'X-CinaToken-Billing-Currency': 'CNY',
	}
	if (allocation !== null) headers['X-CinaToken-Charge-Allocation'] = allocation
	return new Response(body, { headers })
}
function csv(rows = [activityChargeLog], optIn = true): string {
	return serializeUserActivityCsv(rows, 'CNY', optIn)
}
async function render(
	locale: keyof typeof activityMessages,
	log = activityChargeLog,
	currency = 'CNY',
	list = false
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						account: { activity: activityMessages[locale] },
						adminRequestLogs: requestChargeSplitMessages[locale],
					},
				},
			},
		},
	})
	const element = list
		? createElement(ActivityRequestList, {
				data: { ...activityChargeData, billingCurrency: currency, logs: [log] },
				disabled: false,
				onDetails: () => {},
				onPage: () => {},
			})
		: createElement(ActivityChargeSplit, { log, currency })
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

test('Activity Web explicitly negotiates charge allocation and keeps strict safe legacy/extended responses', async () => {
	for (const chargedWalletCost of [undefined, null, 0, 0.1, 0.000001]) {
		const row = { ...activityChargeLog, chargedWalletCost }
		if (chargedWalletCost === undefined) delete row.chargedWalletCost
		const data = { ...activityChargeData, logs: [row] }
		const api = createCinaTokenApi((async (input) => {
			const query = new URL(String(input), 'https://qa.invalid').searchParams
			assert.equal(query.get('include_charge_allocation'), 'true')
			assert.equal(query.get('include_wallet'), 'true')
			return Response.json({ success: true, data })
		}) as typeof fetch)
		assert.deepEqual((await api.activity(options)).logs, [row])
	}
	for (const chargedWalletCost of ['0.100000', true, -1, {}, Infinity])
		assert.equal(
			activityDataSchema.safeParse({
				...activityChargeData,
				logs: [{ ...activityChargeLog, chargedWalletCost }],
			}).success,
			false
		)
	assert.equal(
		activityDataSchema.safeParse({
			...activityChargeData,
			logs: [{ ...activityChargeLog, request_body: 'PRIVATE' }],
		}).success,
		false
	)
})

test('Activity downloads new versioned allocation CSV and unchanged legacy CSV with exact scope', async () => {
	for (const optIn of [false, true]) {
		const api = createCinaTokenApi((async (input) => {
			const u = new URL(String(input), 'https://qa.invalid')
			assert.equal(u.searchParams.get('include_charge_allocation'), 'true')
			assert.equal(u.searchParams.get('api_key_id'), 'qa-key')
			return response(csv(undefined, optIn), optIn ? 'v1' : null)
		}) as typeof fetch)
		const result = await api.exportActivityCsv({
			...options,
			api_key_id: 'qa-key',
		})
		assert.equal(result.workspaceId, options.expectedWorkspaceId)
		assert.equal(result.rowCount, 1)
		assert.equal(
			(await result.blob.text()).includes('charged_wallet_cost_cny'),
			optIn
		)
	}
	for (const [chargedCost, chargedWalletCost] of [
		[0.1 + 0.2, 0.1],
		[0.000002, 0.000001],
		[0, 0],
	])
		await readActivityCsvResponse(
			response(csv([{ ...activityChargeLog, chargedCost, chargedWalletCost }]))
		)
	const result = await readActivityCsvResponse(
		response(
			csv([
				{ ...activityChargeLog, chargedWalletCost: null },
				{ ...activityChargeLog, id: 'gen-second', chargedWalletCost: 0.4 },
			]),
			'v1',
			2
		)
	)
	assert.equal(result.rowCount, 2)
	const empty = await readActivityCsvResponse(response(csv([]), 'v1', 0))
	assert.equal(empty.rowCount, 0)
})

test('Activity CSV rejects unacknowledged, malformed, partial, unsafe or inconsistent allocations', async () => {
	const valid = csv()
	const zeroCsv = csv([
		{ ...activityChargeLog, chargedCost: 0, chargedWalletCost: 0 },
	])
	const high = {
		...activityChargeLog,
		chargedCost: 9_000_000_000,
		chargedWalletCost: 0.000001,
	}
	const highCsv = csv([high])
	assert.match(highCsv, /"",""\r\n$/u)
	await readActivityCsvResponse(response(highCsv))
	await assert.rejects(
		readActivityCsvResponse(
			response(
				highCsv.replace(/"",""\r\n$/u, '"8999999999.999998","0.000001"\r\n')
			)
		),
		/invalid Activity export/u
	)
	await assert.rejects(
		readActivityCsvResponse(
			response(
				zeroCsv.replace('"0","120"', '"0.' + '0'.repeat(400) + '1","120"')
			)
		),
		/invalid Activity export/u
	)
	for (const value of [
		response(valid, null),
		response(csv(undefined, false), 'v1'),
		response(valid, 'v2'),
		response(valid.replace('"0.2","0.1"', '"0.1","0.1"')),
		response(valid.replace('"0.2","0.1"', '"","0.1"')),
		response(valid.replace('"0.2","0.1"', '"0.2",""')),
		response(valid.replace('"0.2","0.1"', '"0.2","0.00000001"')),
		response(valid.replace('"0.2","0.1"', '"0.2","Infinity"')),
		response(valid.replace('"0.2","0.1"', '"0.2","=PRIVATE"')),
	])
		await assert.rejects(
			readActivityCsvResponse(value),
			/invalid Activity export/u
		)
})

test('Activity list and allocation card share four-language recorded money semantics and currency', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const)
		for (const currency of ['USD', 'CNY']) {
			const html = await render(locale, activityChargeLog, currency, true),
				messages = requestChargeSplitMessages[locale].chargeSplit
			assert.ok(html.includes(messages.period))
			assert.ok(html.includes(messages.wallet))
			assert.ok(html.includes(messages.hint))
			assert.ok(!html.includes('0.19999999'))
			assert.ok(!html.includes('cinatoken.adminRequestLogs.'))
			const card = await render(locale, activityChargeLog, currency)
			assert.ok(card.includes(messages.total))
			assert.ok(card.includes(messages.hint))
		}
})

test('Activity charge display preserves zeros/micro-units and never invents an unavailable wallet share', async () => {
	for (const [chargedCost, chargedWalletCost] of [
		[0, 0],
		[0.3, 0],
		[0.3, 0.3],
		[0.000002, 0.000001],
		[0.1 + 0.2, 0.1],
	]) {
		const html = await render('en', {
			...activityChargeLog,
			chargedCost,
			chargedWalletCost,
		})
		assert.ok(html.includes(requestChargeSplitMessages.en.chargeSplit.hint))
		assert.ok(!html.includes('0.19999999'))
	}
	for (const chargedWalletCost of [undefined, null, 0.4]) {
		const html = await render('en', { ...activityChargeLog, chargedWalletCost })
		const text = chargedWalletCost === 0.4 ? 'inconsistent' : 'missing'
		assert.ok(html.includes(requestChargeSplitMessages.en.chargeSplit[text]))
		assert.match(html, /<dd[^>]*>—<\/dd>/u)
	}
	for (const chargedCost of [1e-16, Number.MIN_VALUE, Number.MAX_VALUE]) {
		const html = await render('en', {
			...activityChargeLog,
			chargedCost,
			chargedWalletCost: 0,
		})
		assert.ok(!html.includes('¥0.00'))
		assert.ok(
			html.includes(requestChargeSplitMessages.en.chargeSplit.inconsistent)
		)
	}
	const high = await render('en', {
		...activityChargeLog,
		chargedCost: 9_000_000_000,
		chargedWalletCost: 0.000001,
	})
	assert.ok(
		high.includes(requestChargeSplitMessages.en.chargeSplit.inconsistent)
	)
	assert.match(high, /<dd[^>]*>—<\/dd>/u)
	const euro = await render('en', activityChargeLog, 'EUR')
	assert.ok(euro.includes('€0.20'))
	const invalid = await render('en', activityChargeLog, 'invalid')
	assert.ok(!invalid.includes('0.20'))
	assert.match(invalid, /<dd[^>]*>—<\/dd>/u)
})
