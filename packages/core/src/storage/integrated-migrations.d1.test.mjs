import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
const directory = new URL('../../migrations-d1/', import.meta.url);
const sources = readdirSync(directory)
	.filter((n) => n.endsWith('.sql'))
	.sort();
const apply = (db, n) => db.exec(readFileSync(new URL(n, directory), 'utf8'));

test('appended upstream migrations preserve main balances and the provider foreign-key closure', () => {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys=ON');
	try {
		for (const n of sources.filter((n) => n < '0078')) apply(db, n);
		db.exec(`INSERT INTO providers(id,name,endpoints,shared_channel_type) VALUES('provider','Alias','{"openai":{"base":"https://example.invalid/v1"}}','main-shared-channel');
   INSERT INTO models(id,display_name) VALUES('model','Model');
   INSERT INTO model_routes(id,model_id,provider_id,provider_model_name,upstream_operation) VALUES('route','model','provider','private-model','chat.completions');
   INSERT INTO model_endpoints(id,model_id,provider_id,provider_slug,tag,audio_capabilities,image_capabilities) VALUES('endpoint','model','provider','provider','tag','{"v":1}','{"marker":"retain"}');
   INSERT INTO model_endpoint_routes(endpoint_id,route_target_id,subject_fingerprint) VALUES('endpoint','route','${'a'.repeat(64)}');
   INSERT INTO route_data_policies(route_target_id,retention_days,subject_fingerprint) VALUES('route',0,'${'a'.repeat(64)}');
   INSERT INTO users(id,email,budget_max,budget_spent) VALUES('u','u@example.invalid',10,2.5);
   INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug) VALUES('w','personal','u','Workspace','w');
   INSERT INTO api_keys(id,key,user_id,workspace_id) VALUES('k','test-only-key','u','w');
   INSERT INTO user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,expires_at,created_at,updated_at)
    VALUES('pending','u','k',0,10000000,100000,'2099-01-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');`);
		const tables = ['model_routes', 'model_endpoints', 'model_endpoint_routes', 'route_data_policies'];
		const before = tables.map((n) => db.prepare(`SELECT * FROM ${n}`).all());
		for (const n of sources.filter((n) => n >= '0078')) apply(db, n);
		assert.deepEqual(
			tables.map((n) => db.prepare(`SELECT * FROM ${n}`).all()),
			before,
		);
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
		assert.deepEqual(
			{
				...db
					.prepare(
						"SELECT budget_spent_micros,budget_reserved_micros,wallet_granted,wallet_spent FROM users WHERE id='u'",
					)
					.get(),
			},
			{ budget_spent_micros: 2500000, budget_reserved_micros: 100000, wallet_granted: 0, wallet_spent: 0 },
		);
		assert.equal(
			db.prepare("SELECT shared_channel_type FROM providers WHERE id='provider'").get().shared_channel_type,
			'main-shared-channel',
		);
		db.exec("INSERT INTO providers(id,name,kind) VALUES('second','Alias','new-template')");
		assert.throws(
			() => db.exec("INSERT INTO providers(id,name,kind) VALUES('duplicate','Alias','new-template')"),
			/UNIQUE/,
		);
		assert.throws(() => db.exec("DELETE FROM providers WHERE id='provider'"), /FOREIGN KEY/);
	} finally {
		db.close();
	}
});
