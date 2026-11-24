import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import type { RequestLogsRepository } from '../storage/gateway-repository-interfaces';
import { createD1RequestLogsRepository } from './d1/request-logs.impl';
import { createMySqlRequestLogsRepository } from './mysql/request-logs.impl';
import { createPostgresRequestLogsRepository } from './postgres/request-logs.impl';
import {
	appendModelIdPrefixCondition,
	appendProviderIdsCondition,
	escapeSqlLike,
	normalizeRequestLogIngressHost,
	normalizeRequestLogModelIdPrefix,
	normalizeRequestLogProviderIds,
} from './request-log-filters';

describe('request log list filters', () => {
	it('normalizes bounded provider ID sets without changing literal names or case', () => {
		assert.equal(normalizeRequestLogProviderIds(undefined), undefined);
		assert.equal(normalizeRequestLogProviderIds(''), undefined);
		assert.deepEqual(normalizeRequestLogProviderIds(' b, A, b,,a,目录🧪 '), ['A', 'a', 'b', '目录🧪']);
		assert.deepEqual(normalizeRequestLogProviderIds(" x' OR 1=1 --,p_%\\id "), ['p_%\\id', "x' OR 1=1 --"]);
		const maximum = Array.from({ length: 10 }, (_, index) => String(index) + 'x'.repeat(599));
		assert.equal(maximum.join(',').length, 6009);
		assert.deepEqual(normalizeRequestLogProviderIds(maximum.join(',')), maximum);
		assert.deepEqual(normalizeRequestLogProviderIds(Array(11).fill('same').join(',')), ['same']);
	});
	it('rejects malformed or empty explicit provider sets instead of broadening the query', () => {
		for (const value of [
			null,
			0,
			false,
			[],
			['a'],
			{},
			' ',
			', ,',
			'a\nb',
			'a,\tb',
			'x'.repeat(601),
			'\ud800',
			'a,\udfff',
			','.repeat(6010),
			Array.from({ length: 11 }, (_, i) => `p${i}`).join(','),
		])
			assert.throws(() => normalizeRequestLogProviderIds(value), /Invalid provider IDs/u);
	});
	it('escapes like wildcards and the escape character', () => {
		assert.equal(escapeSqlLike('mcp:a_b%c\\d'), 'mcp:a\\_b\\%c\\\\d');
	});

	it('builds an IN list for provider ids and ignores blanks', () => {
		const conditions: string[] = [];
		const bindValues: unknown[] = [];
		appendProviderIdsCondition(conditions, bindValues, 'rl.provider_id', [' octafuse-tools ', '', 'octafuse-mcp']);
		assert.deepEqual(conditions, ['rl.provider_id IN (?, ?)']);
		assert.deepEqual(bindValues, ['octafuse-tools', 'octafuse-mcp']);
	});

	it('skips an empty provider id list', () => {
		const conditions: string[] = [];
		appendProviderIdsCondition(conditions, [], 'provider_id', []);
		assert.deepEqual(conditions, []);
	});

	it('builds a literal case-sensitive prefix without LIKE wildcard semantics', () => {
		const conditions: string[] = [];
		const bindValues: unknown[] = [];
		appendModelIdPrefixCondition(conditions, bindValues, 'rl.model_id', 'mcp:deep_wiki/');
		assert.deepEqual(conditions, ['SUBSTR(rl.model_id, 1, LENGTH(?)) COLLATE BINARY = ?']);
		assert.deepEqual(bindValues, ['mcp:deep_wiki/', 'mcp:deep_wiki/']);
	});
});
// Execute each production dialect's count/list predicates against SQLite. Only
// placeholder syntax, LEFT and binary comparison syntax are adapted; this does
// not replace native-engine/collation acceptance.
function ingressFixture(driver: 'd1' | 'mysql' | 'postgres', modelIds?: Array<string | null>) {
	const database = new DatabaseSync(':memory:');
	database.exec(`CREATE TABLE users (id TEXT, external_system TEXT);
		CREATE TABLE api_key_request_logs (id TEXT, workspace_id TEXT, api_key_id TEXT,
		user_id TEXT, user_email TEXT, model_id TEXT, provider_id TEXT, ingress_host TEXT, created_at TEXT);`);
	const host = 'Gateway.Example.test:8443';
	const hostile = "edge_%' OR 1=1 --";
	const insert = database.prepare('INSERT INTO api_key_request_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
	const rows: Array<readonly [string, string | null, string, string, string | null]> = modelIds
		? modelIds.map((model, index) => [String(index), host, 'workspace-1', 'octafuse-mcp', model])
		: [
				['match-1', host, 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
				['match-2', host, 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
				['prefix', host + '.other', 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
				['case', host.toLowerCase(), 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
				['workspace', host, 'workspace-2', 'octafuse-mcp', 'mcp:qa/search'],
				['provider', host, 'workspace-1', 'other', 'mcp:qa/search'],
				['hostile', hostile, 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
				['legacy', null, 'workspace-1', 'octafuse-mcp', 'mcp:qa/search'],
			];
	for (const [id, ingress, workspace, provider, model] of rows)
		insert.run(id, workspace, 'key-1', 'user-1', 'user@example.test', model, provider, ingress, '2026-10-18 00:00:00');
	database.exec('PRAGMA query_only = ON');
	const queries: Array<{ sql: string; values: unknown[] }> = [];
	function execute(sql: string, values: unknown[]) {
		queries.push({ sql, values: [...values] });
		const adapted = sql
			.replace(/\$\d+/gu, '?')
			.replace(/BINARY rl\.ingress_host = BINARY \?/gu, 'rl.ingress_host = ?')
			.replace(
				/LEFT\(BINARY rl\.model_id, LENGTH\(\?\)\) = BINARY \?/gu,
				'SUBSTR(CAST(rl.model_id AS BLOB), 1, LENGTH(CAST(? AS BLOB))) = CAST(? AS BLOB)',
			)
			.replace(
				/LEFT\(rl\.model_id, LENGTH\(\?\)\) COLLATE "C" = \? COLLATE "C"/gu,
				'SUBSTR(rl.model_id, 1, LENGTH(?)) COLLATE BINARY = ? COLLATE BINARY',
			);
		return database.prepare(adapted).all(...(values as SQLInputValue[]));
	}
	const d1 = {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					return {
						async first() {
							return execute(sql, values)[0] ?? null;
						},
						async all() {
							return { results: execute(sql, values) };
						},
					};
				},
			};
		},
	};
	const mysql = {
		async query(sql: string, values: unknown[]) {
			return [execute(sql, values), []];
		},
	};
	const postgres = {
		async unsafe(sql: string, values: unknown[]) {
			return execute(sql, values);
		},
	};
	let repo: RequestLogsRepository;
	if (driver === 'd1') repo = createD1RequestLogsRepository({ raw: d1 } as unknown as D1DatabaseClient);
	else if (driver === 'mysql')
		repo = createMySqlRequestLogsRepository({ raw: mysql } as unknown as MySqlDatabaseClient);
	else repo = createPostgresRequestLogsRepository({ raw: postgres } as unknown as PostgresDatabaseClient);
	return { database, repo, queries, host, hostile };
}

it('ingress filters retain stored case, ports and IPv6 without URL rewriting, and reject invalid input', () => {
	for (const host of ['Gateway.Example.test:8443', '[2001:db8::1]:8787', 'localhost', 'x'.repeat(255)])
		assert.equal(normalizeRequestLogIngressHost(` ${host} `.trim()), host);
	assert.equal(normalizeRequestLogIngressHost(' Gateway.Example.test:8443 '), 'Gateway.Example.test:8443');
	assert.equal(normalizeRequestLogIngressHost(undefined), undefined);
	assert.equal(normalizeRequestLogIngressHost(''), undefined);
	for (const invalid of [null, 123, [], ['host'], {}, ' ', '\n', 'host\tname', 'x'.repeat(256)])
		assert.throws(() => normalizeRequestLogIngressHost(invalid), /Invalid ingress host/u);
});

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	it(`${driver} ingress filter scopes both count and list with existing workspace/key/provider/prefix filters`, async () => {
		const f = ingressFixture(driver);
		try {
			const result = await f.repo.getRequestLogs({
				page: 2,
				pageSize: 1,
				ingressHost: ` ${f.host} `,
				workspaceId: 'workspace-1',
				apiKeyId: 'key-1',
				userId: 'user-1',
				providerId: 'octafuse-mcp',
				providerIds: ['octafuse-mcp'],
				modelIdPrefix: 'mcp:qa/',
			});
			assert.equal(result.total, 2);
			assert.equal(result.logs.length, 1);
			assert.equal(result.logs[0].ingress_host, f.host);
			assert.equal(result.logs[0].provider_id, 'octafuse-mcp');
			assert.equal(f.queries.length, 2);
			for (const query of f.queries) {
				assert.ok(query.values.includes(f.host));
				assert.ok(!query.sql.includes(f.host));
				assert.match(query.sql, /ingress_host = (?:BINARY )?(?:\?|\$\d+)/u);
				if (driver === 'mysql') assert.match(query.sql, /BINARY rl\.ingress_host = BINARY \?/u);
			}
		} finally {
			f.database.close();
		}
	});
	it(`${driver} ingress filters bind wildcards/quotes literally and reject invalid scope before any read`, async () => {
		const f = ingressFixture(driver);
		try {
			const hostile = await f.repo.getRequestLogs({ ingressHost: f.hostile });
			assert.equal(hostile.total, 1);
			assert.deepEqual(
				hostile.logs.map((log) => log.id),
				['hostile'],
			);
			for (const query of f.queries) {
				assert.ok(!query.sql.includes(f.hostile));
				assert.ok(query.values.includes(f.hostile));
			}
			const count = f.queries.length;
			for (const ingressHost of [' ', '\n', 'x'.repeat(256)])
				await assert.rejects(f.repo.getRequestLogs({ ingressHost }));
			assert.equal(f.queries.length, count);
			assert.equal((await f.repo.getRequestLogs({})).total, 8);
			assert.equal((await f.repo.getRequestLogs({ ingressHost: '' })).total, 8);
		} finally {
			f.database.close();
		}
	});
}

it('model prefix normalization retains literal case/Unicode and rejects malformed scope without silently clearing it', () => {
	for (const prefix of ['mcp:Deep_Wiki%\\目录🧪/', "x' OR 1=1 --", 'x'.repeat(600)])
		assert.equal(normalizeRequestLogModelIdPrefix(prefix), prefix);
	assert.equal(normalizeRequestLogModelIdPrefix(' mcp:QA/ '), 'mcp:QA/');
	assert.equal(normalizeRequestLogModelIdPrefix(undefined), undefined);
	assert.equal(normalizeRequestLogModelIdPrefix(''), undefined);
	for (const invalid of [null, 42, [], ['model'], {}, ' ', '\n', 'mcp:a\tb', 'x'.repeat(601), '\ud800'])
		assert.throws(() => normalizeRequestLogModelIdPrefix(invalid), /Invalid model prefix/u);
});

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	it(`${driver} model prefixes bind twice and match literal startsWith for case, wildcards, quotes and Unicode`, async () => {
		const prefix = 'mcp:Deep_Wiki%\\目录🧪/';
		const models = [
			prefix + 'search',
			prefix + 'docs',
			prefix.toLowerCase() + 'search',
			'mcp:DeepXWiki%\\目录🧪/search',
			'mcp:Deep_WikiXYZ\\目录🧪/search',
			'mcp:Deep_Wiki%目录🧪/search',
			"x' OR 1=1 --/search",
			null,
		];
		const f = ingressFixture(driver, models);
		try {
			for (const modelIdPrefix of [prefix, "x' OR 1=1 --", 'mcp:deep_', 'mcp:Deep_Wiki%\\目录🧪/missing']) {
				const expected = models.flatMap((model, index) => (model?.startsWith(modelIdPrefix) ? [String(index)] : []));
				const result = await f.repo.getRequestLogs({ modelIdPrefix, ingressHost: f.host, pageSize: 100 });
				assert.equal(result.total, expected.length);
				assert.deepEqual(result.logs.map((log) => log.id).sort(), expected.sort());
				for (const query of f.queries.slice(-2)) {
					assert.ok(!query.sql.includes(modelIdPrefix));
					assert.equal(query.values.filter((value) => value === modelIdPrefix).length, 2);
					assert.doesNotMatch(query.sql, /\bLIKE\b/u);
					if (driver === 'mysql') assert.match(query.sql, /LEFT\(BINARY rl\.model_id, LENGTH\(\?\)\) = BINARY \?/u);
					if (driver === 'postgres')
						assert.match(query.sql, /LEFT\(rl\.model_id, LENGTH\(\$\d+\)\) COLLATE "C" = \$\d+ COLLATE "C"/u);
				}
			}
			const page = await f.repo.getRequestLogs({ modelIdPrefix: prefix, page: 2, pageSize: 1 });
			assert.equal(page.total, 2);
			assert.equal(page.logs.length, 1);
			assert.ok(page.logs[0].model_id?.startsWith(prefix));
		} finally {
			f.database.close();
		}
	});
	it(`${driver} rejects invalid model prefixes before reading and preserves omitted/empty filter compatibility`, async () => {
		const f = ingressFixture(driver);
		try {
			for (const modelIdPrefix of [' ', 'mcp:a\nb', 'x'.repeat(601), '\ud800'])
				await assert.rejects(f.repo.getRequestLogs({ modelIdPrefix }), /Invalid model prefix/u);
			assert.equal(f.queries.length, 0);
			assert.equal((await f.repo.getRequestLogs({})).total, 8);
			assert.equal((await f.repo.getRequestLogs({ modelIdPrefix: '' })).total, 8);
		} finally {
			f.database.close();
		}
	});
}

for (const driver of ['d1', 'mysql', 'postgres'] as const) {
	it(`${driver} provider sets preserve server pagination and intersect single-provider/workspace scope`, async () => {
		const f = ingressFixture(driver);
		try {
			const providerIds = normalizeRequestLogProviderIds('other,octafuse-mcp,other');
			const union = await f.repo.getRequestLogs({ providerIds, workspaceId: 'workspace-1', page: 2, pageSize: 2 });
			assert.equal(union.total, 7);
			assert.equal(union.logs.length, 2);
			assert.ok(union.logs.every((log) => providerIds!.includes(log.provider_id!)));
			const intersection = await f.repo.getRequestLogs({
				providerIds,
				providerId: 'octafuse-mcp',
				workspaceId: 'workspace-1',
			});
			assert.equal(intersection.total, 6);
			assert.ok(intersection.logs.every((log) => log.provider_id === 'octafuse-mcp'));
			const disjoint = await f.repo.getRequestLogs({ providerIds: ['other'], providerId: 'octafuse-mcp' });
			assert.equal(disjoint.total, 0);
			assert.deepEqual(disjoint.logs, []);
			for (const query of f.queries) {
				assert.match(query.sql, /provider_id IN \(/u);
				assert.ok(!query.sql.includes('octafuse-mcp'));
				assert.ok(query.values.includes('other'));
			}
		} finally {
			f.database.close();
		}
	});
}
