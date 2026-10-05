import assert from 'node:assert/strict'
import test from 'node:test'
import { nftMessages } from './messages'

test('all four NFT locales cover identical keys, chain states and net USD ownership guidance', () => {
	const expected = Object.keys(nftMessages.en).sort()
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(nftMessages[locale]).sort(), expected)
		for (const value of Object.values(nftMessages[locale]))
			assert.ok(value.trim())
		for (const status of [
			'pending',
			'processing',
			'submitted',
			'confirmed',
			'failed',
		] as const)
			assert.ok(nftMessages[locale][`status_${status}`])
		assert.match(
			nftMessages[locale].contributionHint,
			locale === 'zh' ? /美元/ : locale === 'ja' ? /米ドル/ : /USD/
		)
	}
})
