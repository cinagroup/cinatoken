import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProviderSearch } from './provider-search'

test('provider deep links retain valid search and protocol filters', () => {
	assert.deepEqual(
		validateProviderSearch({ q: 'alpha provider', filter: 'dashscope' }),
		{ q: 'alpha provider', filter: 'dashscope' }
	)
})
test('untrusted URL values fall back without passing unexpected fields into the page', () => {
	for (const filter of ['unknown', ['active'], null, 1]) {
		assert.deepEqual(
			validateProviderSearch({ q: ['alpha'], filter, secret: 'not-a-filter' }),
			{ q: '', filter: 'all' }
		)
	}
	assert.deepEqual(validateProviderSearch({ q: 'x'.repeat(201) }), {
		q: '',
		filter: 'all',
	})
	assert.deepEqual(validateProviderSearch({}), { q: '', filter: 'all' })
})
