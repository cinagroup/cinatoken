import assert from 'node:assert/strict';
import test from 'node:test';
import {
	webFetchErrorForLog,
	webFetchRequestBodyForLog,
	webFetchResponseBodyForLog,
} from './web-fetch-log';

test('web-fetch persistence strips URL credentials, query strings, and fragments', () => {
	const request = webFetchRequestBodyForLog(
		'https://user:password@example.com:8443/private/path?api_key=REQUEST_SECRET#fragment',
		'firecrawl',
	);
	const response = webFetchResponseBodyForLog({
		url: 'https://cdn.example/result?signature=RESPONSE_SECRET#fragment',
		title: 'Result',
		content: 'safe preview',
	});
	assert.match(request ?? '', /https:\/\/example\.com:8443\/private\/path/);
	assert.doesNotMatch(request ?? '', /password|REQUEST_SECRET|fragment/);
	assert.match(response ?? '', /https:\/\/cdn\.example\/result/);
	assert.doesNotMatch(response ?? '', /RESPONSE_SECRET|fragment/);
});

test('web-fetch error persistence records only the error class', () => {
	assert.equal(
		webFetchErrorForLog(new TypeError('request to https://example.test/?token=SECRET failed')),
		'TypeError',
	);
});
