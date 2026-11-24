import assert from 'node:assert/strict';
import test from 'node:test';
import { configAuditMetadata } from '../db/system-config-audit';
import {
	STREAM_FIRST_EVENT_TIMEOUT_MS_KEY,
	STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS_KEY,
	normalizeFirstEventTimeoutMsInput,
	normalizeFirstEventTimeoutRouteGroupsInput,
	parseFirstEventTimeoutMs,
	parseFirstEventTimeoutRouteGroups,
	timeoutMsConfigValue,
	timeoutRouteGroupsConfigValue,
} from './stream-first-event-timeout-config';

test('legacy timeout reads retain the original parseInt semantics while new writes require bounded integer text', () => {
	for (const [raw, effective] of [
		[null, 0],
		['', 0],
		[' 0 ', 0],
		['-1', 0],
		['unknown', 0],
		['1e3', 1],
		['10ms', 10],
		['5.9', 5],
		['+20', 20],
		['00025', 25],
		['2147483648', 2147483648],
		['9'.repeat(400), 0],
	] as const)
		assert.equal(parseFirstEventTimeoutMs(raw), effective, String(raw));
	for (const raw of [
		'1e3',
		'10ms',
		'5.9',
		'+20',
		'-1',
		'2147483648',
		'9007199254740993',
		'NaN',
		'Infinity',
		{},
		0,
		null,
	]) {
		assert.equal(normalizeFirstEventTimeoutMsInput(raw), null, String(raw));
	}
	for (const [raw, value] of [
		['', ''],
		[' \t ', ''],
		[' 0 ', '0'],
		[' 00025 ', '00025'],
		['2147483647', '2147483647'],
	]) {
		assert.equal(normalizeFirstEventTimeoutMsInput(raw), value);
	}
});

test('group reads preserve case-sensitive literal names and only treat whole * or all as wildcards', () => {
	for (const raw of [null, '', '  ', ' , , ']) assert.deepEqual(parseFirstEventTimeoutRouteGroups(raw), ['default']);
	for (const raw of ['*', ' all ', 'ALL', 'All']) assert.equal(parseFirstEventTimeoutRouteGroups(raw), '*');
	assert.deepEqual(parseFirstEventTimeoutRouteGroups(' *, VIP, vip,,all '), ['*', 'VIP', 'vip', 'all']);
	assert.deepEqual(parseFirstEventTimeoutRouteGroups('生产组,default,default'), ['生产组', 'default', 'default']);
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput(' *, VIP, vip,,all '), '*, VIP, vip,,all');
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput(' ALL '), 'ALL');
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput(''), '');
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput(' , , '), null);
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput('x'.repeat(4096)), 'x'.repeat(4096));
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput('x'.repeat(4097)), null);
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput([]), null);
	assert.equal(normalizeFirstEventTimeoutRouteGroupsInput('emoji-😀'), 'emoji-😀');
	for (const value of ['\ud800', '\udfff', 'vip,\ud800,default']) {
		assert.equal(normalizeFirstEventTimeoutRouteGroupsInput(value), null);
		assert.deepEqual(timeoutRouteGroupsConfigValue(value), { value, source: 'invalid' });
	}
});

test('safe overview projection preserves invalid historical raw values and does not claim they are disabled', () => {
	assert.deepEqual(timeoutMsConfigValue(null), { value: '', source: 'missing' });
	assert.deepEqual(timeoutMsConfigValue('  '), { value: '  ', source: 'missing' });
	assert.deepEqual(timeoutMsConfigValue(' 00025 '), { value: ' 00025 ', source: 'configured' });
	assert.deepEqual(timeoutMsConfigValue('10ms'), { value: '10ms', source: 'invalid' });
	assert.equal(parseFirstEventTimeoutMs(timeoutMsConfigValue('10ms').value), 10);
	assert.deepEqual(timeoutMsConfigValue('2147483648'), { value: '2147483648', source: 'invalid' });
	assert.deepEqual(timeoutRouteGroupsConfigValue(' , '), { value: ' , ', source: 'invalid' });
	assert.deepEqual(timeoutRouteGroupsConfigValue(' *,VIP '), { value: ' *,VIP ', source: 'configured' });
});

test('timeout audit metadata names each safe key but never serializes its value', () => {
	for (const key of [STREAM_FIRST_EVENT_TIMEOUT_MS_KEY, STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS_KEY]) {
		const metadata = configAuditMetadata({
			auditId: crypto.randomUUID(),
			key,
			value: 'private-value-canary',
			actorKind: 'console',
			actorId: 'console:fixture',
			nowIso: '2026-10-23T00:00:00.000Z',
		});
		assert.deepEqual(metadata, { configKey: key, channel: null, action: 'set' });
		assert.equal(JSON.stringify(metadata).includes('private-value-canary'), false);
	}
});
