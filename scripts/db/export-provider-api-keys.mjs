#!/usr/bin/env node
/**
 * Export provider_api_keys before applying migration 0015 (single provider key).
 *
 * Migration keeps only the first active key per provider (priority DESC, created_at ASC).
 * Use this JSON to rebuild discarded keys as separate provider rows after cutover.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/db/export-provider-api-keys.mjs > provider-api-keys-backup.json
 *   # or with D1 local sqlite path via better-sqlite3 if available — prefer postgres/mysql for ops.
 *
 * Env:
 *   DATABASE_URL — postgres or mysql connection string
 *   DATABASE_DRIVER — postgres | mysql (default: inferred from URL scheme)
 */

import process from 'node:process';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}

const driver =
	process.env.DATABASE_DRIVER?.trim() ||
	(url.startsWith('mysql') ? 'mysql' : 'postgres');

async function exportPostgres() {
	const { default: postgres } = await import('postgres');
	const sql = postgres(url, { max: 1 });
	try {
		const [schemas] = await sql`
			SELECT
				to_regclass('cinatoken_gateway.provider_api_keys') IS NOT NULL AS canonical,
				to_regclass('octafuse_gateway.provider_api_keys') IS NOT NULL AS legacy
		`;
		if (schemas.canonical && schemas.legacy) {
			throw new Error(
				'provider_api_keys exists in both cinatoken_gateway and octafuse_gateway; reconcile manually before export'
			);
		}
		const sourceSchema = schemas.canonical
			? 'cinatoken_gateway, public'
			: schemas.legacy
				? 'octafuse_gateway, public'
				: null;
		if (!sourceSchema) {
			throw new Error('provider_api_keys was not found in the canonical or legacy PostgreSQL schema');
		}
		await sql`SELECT set_config('search_path', ${sourceSchema}, false)`;
		const rows = await sql`
			SELECT id, provider_id, label, api_key, status, weight, priority, limit_config,
			       created_at::text AS created_at, updated_at::text AS updated_at
			FROM provider_api_keys
			ORDER BY provider_id, priority DESC, created_at ASC
		`;
		return rows;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

async function exportMysql() {
	const mysql = await import('mysql2/promise');
	const pool = mysql.createPool(url);
	try {
		const [rows] = await pool.query(
			`SELECT id, provider_id, label, api_key, status, weight, priority, limit_config,
			        created_at, updated_at
			 FROM provider_api_keys
			 ORDER BY provider_id, priority DESC, created_at ASC`
		);
		return rows;
	} finally {
		await pool.end();
	}
}

const rows = driver === 'mysql' ? await exportMysql() : await exportPostgres();

const byProvider = new Map();
for (const row of rows) {
	const list = byProvider.get(row.provider_id) ?? [];
	list.push(row);
	byProvider.set(row.provider_id, list);
}

const kept = [];
const discarded = [];
for (const [providerId, keys] of byProvider) {
	const active = keys.filter((k) => k.status === 'active');
	const first = active[0] ?? null;
	if (first) kept.push({ provider_id: providerId, key: first });
	for (const k of keys) {
		if (!first || k.id !== first.id) {
			discarded.push({ provider_id: providerId, key: k, reason: first ? 'not_first_active' : 'no_active_kept' });
		}
	}
}

process.stdout.write(
	JSON.stringify(
		{
			exported_at: new Date().toISOString(),
			driver,
			total_keys: rows.length,
			providers: byProvider.size,
			kept_count: kept.length,
			discarded_count: discarded.length,
			kept,
			discarded,
			all_keys: rows,
		},
		null,
		2
	) + '\n'
);
