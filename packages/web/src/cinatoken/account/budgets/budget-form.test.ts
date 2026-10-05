import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBudgetDraft } from './budget-form'

test('budget forms preserve server rounding and accept decimal inputs', () => {
	assert.equal(parseBudgetDraft(' 10.1234567 '), 10.1234567)
	assert.equal(parseBudgetDraft('.0000005'), 0.0000005)
	assert.equal(parseBudgetDraft('1e2'), 100)
})
test('budget forms reject empty, nonnumeric, nonpositive and unsafe micro-units', () => {
	for (const value of [
		'',
		' ',
		'0',
		'-1',
		'NaN',
		'Infinity',
		'0x10',
		'1,000',
		'0.0000001',
		'9007199255',
	])
		assert.equal(parseBudgetDraft(value), null, value)
})
