import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractUpstreamRequestId, normalizeUpstreamId, resolveGeminiLoggedRequestId } from './upstream-request-id';

function expect(actual: unknown): { toBe(expected: unknown): void; toBeNull(): void } {
	return {
		toBe: (expected) => assert.equal(actual, expected),
		toBeNull: () => assert.equal(actual, null),
	};
}

describe('extractUpstreamRequestId', () => {
	it('prefers x-request-id over other headers', () => {
		const headers = new Headers({
			'x-request-id': 'req_openai_123',
			'request-id': 'req_anthropic_456',
		});
		expect(extractUpstreamRequestId(headers)).toBe('req_openai_123');
	});

	it('falls back to request-id and x-goog-request-id', () => {
		expect(extractUpstreamRequestId(new Headers({ 'request-id': 'req_abc' }))).toBe('req_abc');
		expect(extractUpstreamRequestId(new Headers({ 'x-goog-request-id': 'goog_xyz' }))).toBe('goog_xyz');
	});

	it('captures vendor/CDN fallback headers (Bedrock, Azure, Wangsu, Qiniu)', () => {
		expect(extractUpstreamRequestId(new Headers({ 'x-amzn-requestid': 'amzn_1' }))).toBe('amzn_1');
		expect(extractUpstreamRequestId(new Headers({ 'x-ms-request-id': 'ms_1' }))).toBe('ms_1');
		expect(
			extractUpstreamRequestId(new Headers({ 'x-ws-request-id': '6a4654e1_PS-SHA_45108-42805' }))
		).toBe('6a4654e1_PS-SHA_45108-42805');
		expect(
			extractUpstreamRequestId(new Headers({ 'http_x_reqid': 'chatptvtx-2d9b7da15a764f169bfc8459bdfec300' }))
		).toBe('chatptvtx-2d9b7da15a764f169bfc8459bdfec300');
	});

	it('parses x-cloud-trace-context trace id segment', () => {
		expect(
			extractUpstreamRequestId(
				new Headers({ 'x-cloud-trace-context': 'abc123def456/0123456789;o=1' })
			)
		).toBe('abc123def456');
	});

	it('prefers standard provider headers over vendor/CDN fallbacks', () => {
		const headers = new Headers({
			'x-ws-request-id': 'ws_cdn_trace',
			'request-id': 'req_real',
		});
		expect(extractUpstreamRequestId(headers)).toBe('req_real');
	});

	it('returns null when no trace headers are present', () => {
		expect(extractUpstreamRequestId(new Headers({ 'content-type': 'application/json' }))).toBeNull();
	});

	it('trims valid values and rejects overlong header ids', () => {
		const long = 'a'.repeat(250);
		expect(extractUpstreamRequestId(new Headers({ 'x-request-id': '  req-valid  ' }))).toBe('req-valid');
		expect(extractUpstreamRequestId(new Headers({ 'x-request-id': long }))).toBeNull();
	});
});

describe('normalizeUpstreamId', () => {
	it('trims and returns non-empty strings', () => {
		expect(normalizeUpstreamId('  msg_bdrk_017Sviuyg  ')).toBe('msg_bdrk_017Sviuyg');
		expect(normalizeUpstreamId('chatcmpl-abc')).toBe('chatcmpl-abc');
	});

	it('returns null for empty / non-string values', () => {
		expect(normalizeUpstreamId('')).toBeNull();
		expect(normalizeUpstreamId('   ')).toBeNull();
		expect(normalizeUpstreamId(undefined)).toBeNull();
		expect(normalizeUpstreamId(null)).toBeNull();
		expect(normalizeUpstreamId(123)).toBeNull();
	});

	it('rejects controls, embedded whitespace, non-ASCII, and overlong values', () => {
		expect(normalizeUpstreamId('msg-bad\nid')).toBeNull();
		expect(normalizeUpstreamId('msg bad')).toBeNull();
		expect(normalizeUpstreamId('消息-id')).toBeNull();
		expect(normalizeUpstreamId('a'.repeat(250))).toBeNull();
	});
});

describe('resolveGeminiLoggedRequestId', () => {
	it('prefers header request id over body request id', () => {
		expect(
			resolveGeminiLoggedRequestId({
				headerRequestId: 'req_header',
				bodyRequestId: 'req_body',
			})
		).toBe('req_header');
	});

	it('falls back to body request id only', () => {
		expect(
			resolveGeminiLoggedRequestId({
				headerRequestId: null,
				bodyRequestId: 'req_body',
			})
		).toBe('req_body');
	});

	it('returns null when neither header nor body request id exists (Vertex Express)', () => {
		expect(
			resolveGeminiLoggedRequestId({
				headerRequestId: null,
				bodyRequestId: null,
			})
		).toBeNull();
	});
});
