import assert from 'node:assert/strict'
import test from 'node:test'
import {
	parseWebProxyOrigins,
	webProxyConnectSources,
} from './proxy-origin-policy.mjs'

test('empty Proxy configuration preserves the existing self and WSS policy', () => {
	assert.deepEqual(parseWebProxyOrigins(), [])
	assert.deepEqual(parseWebProxyOrigins('   '), [])
	assert.equal(webProxyConnectSources(), "'self' wss:")
})

test('trusted HTTPS origins and explicit loopback HTTP derive exact WS origins', () => {
	const value =
		'https://proxy.example.com:9443, http://localhost:8787, http://127.0.0.1:8787, http://[::1]:8787, https://192.0.2.10, https://proxy.example.com:9443'
	assert.deepEqual(parseWebProxyOrigins(value), [
		'https://proxy.example.com:9443',
		'http://localhost:8787',
		'http://127.0.0.1:8787',
		'http://[::1]:8787',
		'https://192.0.2.10',
	])
	assert.equal(
		webProxyConnectSources('https://proxy.example.com:9443,http://[::1]:8787'),
		"'self' wss: https://proxy.example.com:9443 http://[::1]:8787 wss://proxy.example.com:9443 ws://[::1]:8787"
	)
})

test('untrusted, coerced, malformed and injectable origin strings fail closed', () => {
	for (const value of [
		'*',
		'https:',
		'wss://proxy.example.com',
		'https://*.example.com',
		'http://proxy.example.com',
		'http://127.0.0.2',
		'https://user:secret@proxy.example.com',
		'https://proxy.example.com/',
		'https://proxy.example.com/v1',
		'https://proxy.example.com?x=1',
		'https://proxy.example.com#x',
		'https://proxy.example.com; script-src *',
		'https://proxy.example.com\nconnect-src *',
		'https://proxy.example.com\r',
		'https://proxy.example.com\t',
		'https://proxy.example.com\0',
		'https://proxy.example.com\\evil',
		'https://proxy.example.com"',
		"https://proxy.example.com'",
		'https://proxy.example.com$host',
		'https://proxy.example.com%0a',
		'https://PROXY.example.com',
		'HTTPS://proxy.example.com',
		'https://例子.com',
		'https://proxy.example.com.',
		'https://proxy..example.com',
		'https://-proxy.example.com',
		'https://proxy-.example.com',
		'https://a_b.example.com',
		'https://proxy.123',
		'https://0x7f000001',
		'https://2130706433',
		'https://127.1',
		'https://127.000.0.1',
		'https://256.1.1.1',
		'https://[2001:db8::1]',
		'https://[0:0:0:0:0:0:0:1]',
		'https://proxy.example.com:0',
		'https://proxy.example.com:0443',
		'https://proxy.example.com:65536',
		'https://proxy.example.com:',
		'https://proxy.example.com,,https://other.example.com',
		',https://proxy.example.com',
		'https://proxy.example.com,',
		`https://${'a'.repeat(64)}.example.com`,
		`https://${Array(5).fill('a'.repeat(60)).join('.')}`,
		Array(17).fill('https://proxy.example.com').join(','),
		'a'.repeat(4097),
	]) {
		assert.throws(
			() => webProxyConnectSources(value),
			(error) =>
				error.message ===
				'CINATOKEN_WEB_PROXY_ORIGINS must contain at most 16 trusted HTTP(S) origins',
			value
		)
	}
})

test('maximum port and DNS labels are accepted without altering authorities', () => {
	const value = `https://${'a'.repeat(63)}.example:65535,https://xn--bcher-kva.example:443`
	assert.equal(parseWebProxyOrigins(value).join(','), value)
})
