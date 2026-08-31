import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchWithSafeRedirects, UnsafeFetchDestinationError } from './safe-redirect-fetch';
import { assertFetchUrlSafe } from './url-guard';

describe('web fetch destination policy', () => {
	it('rejects credentials, fragments, private literals, and encoded IPv4 forms', () => {
		for (const value of [
			'https://user:secret@example.com/result',
			'https://example.com/result#token',
			'https://localhost./result',
			'https://foo.local./result',
			'https://metadata.google.internal./latest/meta-data',
			'https://127.0.0.1/result',
			'https://2130706433/result',
			'https://[::ffff:7f00:1]/result',
			'https://[::ffff:0:127.0.0.1]/result',
			'https://[fe80::1]/result',
			'https://[fec0::1]/result',
			'https://[64:ff9b::7f00:1]/result',
			'https://[64:ff9b:1::1]/result',
			'https://169.254.169.254/latest/meta-data',
		]) {
			assert.equal(assertFetchUrlSafe(value).ok, false, value);
		}
		assert.equal(assertFetchUrlSafe('https://cdn.example.com/result?signature=secret').ok, true);
		assert.equal(assertFetchUrlSafe('https://cdn.example.com./result?signature=secret').ok, true);
		assert.equal(assertFetchUrlSafe('https://[2606:4700:4700::1111]/result').ok, true);
	});

	it('revalidates every redirect and never fetches a private Location', async () => {
		let calls = 0;
		let cancelled = false;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
				status: 302,
				headers: { location: 'http://127.0.0.1/admin' },
			});
		};
		await assert.rejects(
			() => fetchWithSafeRedirects('https://results.example/task', { fetchImpl: fetchImpl as typeof fetch, requireHttps: true }),
			UnsafeFetchDestinationError,
		);
		assert.equal(calls, 1);
		assert.equal(cancelled, true);
	});

	it('follows bounded safe relative redirects, preserves signed queries, and strips cross-origin credentials', async () => {
		const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
		const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
			if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/result?signature=a%2Bb' } });
			return new Response('{"ok":true}', { status: 200 });
		};
		const result = await fetchWithSafeRedirects('https://api.example/task?request=1', {
			fetchImpl: fetchImpl as typeof fetch,
			init: { headers: { authorization: 'Bearer must-not-cross-origin' } },
			requireHttps: true,
		});
		assert.equal(result.redirects, 1);
		assert.equal(result.finalUrl, 'https://cdn.example/result?signature=a%2Bb');
		assert.equal(calls[0]?.redirect, 'manual');
		assert.equal(calls[0]?.headers.get('authorization'), 'Bearer must-not-cross-origin');
		assert.equal(calls[1]?.headers.get('authorization'), null);
		assert.match(calls[1]?.url ?? '', /signature=a%2Bb/);
	});

	it('rejects cleartext result URLs and redirect loops at the configured ceiling', async () => {
		await assert.rejects(
			() => fetchWithSafeRedirects('http://public.example/result', { requireHttps: true }),
			/url must use https/,
		);
		let calls = 0;
		await assert.rejects(() => fetchWithSafeRedirects('https://public.example/a', {
			maxRedirects: 1,
			fetchImpl: (async () => {
				calls += 1;
				return new Response(null, { status: 302, headers: { location: '/a' } });
			}) as typeof fetch,
		}), /redirect limit exceeded/);
		assert.equal(calls, 2);
	});

	it('can reject every IP literal for provider-returned resource URLs', async () => {
		for (const value of [
			'https://8.8.8.8/result',
			'https://[2606:4700:4700::1111]/result',
		]) {
			await assert.rejects(
				() => fetchWithSafeRedirects(value, { requireHttps: true, allowIpLiterals: false }),
				/IP-literal destinations are not allowed/,
			);
		}
		const result = await fetchWithSafeRedirects('https://results.example/result', {
			requireHttps: true,
			allowIpLiterals: false,
			fetchImpl: (async () => new Response('{}')) as typeof fetch,
		});
		assert.equal(result.finalUrl, 'https://results.example/result');
	});
});
