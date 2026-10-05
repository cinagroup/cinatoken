import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	getBusinessDayWindow,
	getBusinessTimezone,
	MAX_BUSINESS_TIMEZONE_LENGTH,
	parseBusinessTimezoneInput,
	resolveBusinessTimezoneConfiguration,
	utcApiToZonedInput,
	zonedInputToUtcApi,
} from './business-timezone';
import type { GatewayRepositories } from '../storage/repositories';

describe('business timezone UTC ↔ wall clock', () => {
	it('roundtrips Shanghai wall clock through UTC API strings', () => {
		const utc = '2026-07-09 10:00:00';
		const local = utcApiToZonedInput(utc, 'Asia/Shanghai');
		assert.equal(local, '2026-07-09T18:00');
		assert.equal(zonedInputToUtcApi(local, 'Asia/Shanghai'), utc);
	});

	it('maps Shanghai midnight to previous-day UTC', () => {
		const local = '2026-07-09T00:00';
		assert.equal(zonedInputToUtcApi(local, 'Asia/Shanghai'), '2026-07-08 16:00:00');
	});

	it('getBusinessDayWindow aligns with Shanghai date key', () => {
		const now = new Date('2026-07-09T08:00:00.000Z');
		const window = getBusinessDayWindow(now, 'Asia/Shanghai');
		assert.equal(window.dateKey, '2026-07-09');
		assert.equal(window.startUtcSql, '2026-07-08 16:00:00');
		assert.equal(window.endExclusiveUtcSql, '2026-07-09 16:00:00');
	});

	it('validates trimmed IANA names and rejects blank, controls, and oversized inputs', () => {
		assert.equal(parseBusinessTimezoneInput(' Asia/Singapore '), 'Asia/Singapore');
		assert.equal(parseBusinessTimezoneInput('UTC'), 'UTC');
		assert.equal(parseBusinessTimezoneInput('Etc/GMT+8'), 'Etc/GMT+8');
		for (const value of ['', '   ', 'Mars/Olympus', 'UTC\n', 'Asia/\u0000Singapore', 'x'.repeat(MAX_BUSINESS_TIMEZONE_LENGTH + 1), '+01:00', '-04:30', 'EST', 10]) {
			assert.equal(parseBusinessTimezoneInput(value), null);
		}
	});

	it('distinguishes legacy missing and invalid configuration without exposing raw values', async () => {
		assert.deepEqual(resolveBusinessTimezoneConfiguration(null), { businessTimezone: 'UTC', source: 'missing' });
		assert.deepEqual(resolveBusinessTimezoneConfiguration('   '), { businessTimezone: 'UTC', source: 'missing' });
		assert.deepEqual(resolveBusinessTimezoneConfiguration('Mars/Olympus'), { businessTimezone: 'UTC', source: 'invalid' });
		assert.deepEqual(resolveBusinessTimezoneConfiguration(' Asia/Shanghai '), { businessTimezone: 'Asia/Shanghai', source: 'configured' });
		assert.deepEqual(resolveBusinessTimezoneConfiguration('EST'), { businessTimezone: 'EST', source: 'legacy' });
		assert.deepEqual(resolveBusinessTimezoneConfiguration('+01:00'), { businessTimezone: '+01:00', source: 'legacy' });
		let reads = 0;
		const repos = { systemConfig: { getConfig: async () => { reads += 1; return ' Asia/Shanghai '; } } } as unknown as GatewayRepositories;
		assert.equal(await getBusinessTimezone(repos), 'Asia/Shanghai');
		assert.equal(reads, 1);
	});

	it('a DST transition changes the UTC length of a business day without changing its local date', () => {
		const window = getBusinessDayWindow(new Date('2026-03-08T12:00:00.000Z'), 'America/Los_Angeles');
		assert.deepEqual(window, {
			dateKey: '2026-03-08',
			startUtcSql: '2026-03-08 08:00:00',
			endExclusiveUtcSql: '2026-03-09 07:00:00',
		});
	});
});
