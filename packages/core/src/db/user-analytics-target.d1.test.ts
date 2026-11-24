import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { createD1AdminAnalyticsRepository } from './d1/admin-analytics.impl';
import type { D1DatabaseClient } from '../storage/database-client';

const start = '2026-10-01 00:00:00';
const end = '2026-10-02 00:00:00';
function fixture() {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, budget_max REAL, budget_spent REAL, wallet_granted REAL, wallet_spent REAL);
	CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
	CREATE TABLE api_key_request_logs (id TEXT PRIMARY KEY, user_id TEXT, user_email TEXT, api_key_id TEXT, model_id TEXT, created_at TEXT,
	input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, charged_cost REAL DEFAULT 0, metered_cost REAL DEFAULT 0, standard_cost REAL DEFAULT 0, status TEXT DEFAULT 'success');
	INSERT INTO users VALUES ('owner',10,2,1,3),('other',20,4,5,2);
	INSERT INTO api_keys VALUES ('live','owner','Live'),('unused','owner','Unused'),('foreign','other','Foreign');`);
	const raw = { prepare(sql: string) { return { bind(...values: SQLInputValue[]) { return { async all() { return {results: db.prepare(sql).all(...values)}; } }; } }; } };
	const repo = createD1AdminAnalyticsRepository({raw} as unknown as D1DatabaseClient);
	const insert = db.prepare('INSERT INTO api_key_request_logs (id,user_id,user_email,api_key_id,model_id,created_at,status) VALUES (?,?,?,?,?,?,?)');
	return {db,repo, log(id: string, owner: string | null, email: string, key: string | null = 'live', at = '2026-10-01 12:00:00', status = 'success') { insert.run(id,owner,email,key,'model-a',at,status); }};
}
test('an email group exposes a target only when all range logs join the same existing user', async () => {
	const f=fixture();
	try {
		f.log('1','owner','same@example.test'); f.log('2','owner','same@example.test');
		f.log('outside','other','same@example.test','foreign','2026-09-30 23:59:59');
		const [row]=await f.repo.queryUserAnalytics({start,end,email:'same@'});
		assert.equal(row?.user_id,'owner'); assert.equal(row?.request_count,2);
		assert.equal(row?.wallet_granted,1); assert.equal(row?.wallet_spent,3);
		assert.equal(row?.budget_spent,2);
	} finally {f.db.close();}
});
test('shared emails, missing owners and a mixture of matched/unmatched logs never select an arbitrary account', async () => {
	const f=fixture();
	try {
		f.log('1','owner','shared@example.test'); f.log('2','other','shared@example.test','foreign');
		f.log('3','owner','mixed@example.test'); f.log('4',null,'mixed@example.test',null);
		f.log('5','removed','gone@example.test',null);
		const rows=await f.repo.queryUserAnalytics({start,end});
		assert.equal(rows.length,3);
		for (const row of rows) assert.equal(row.user_id,null,row.user_email);
		assert.equal(rows.find(row=>row.user_email==='gone@example.test')?.wallet_granted,null);
	} finally {f.db.close();}
});
test('key usage retains unused current keys and deleted-key history across user email changes, excluding other owners', async () => {
	const f=fixture();
	try {
		f.log('1','owner','old@example.test'); f.log('2','owner','new@example.test');
		f.log('3','owner','new@example.test',null,undefined,'error');
		f.log('4','other','other@example.test','foreign');
		const rows=await f.repo.queryKeyAnalytics({start,end,userId:'owner'});
		assert.deepEqual(rows.map(row=>[row.api_key_id,row.request_count,row.key_name]),[['live',2,'Live'],['unused',0,'Unused'],[null,1,null]]);
		assert.equal(rows[2]?.error_count,1);
	} finally {f.db.close();}
});
