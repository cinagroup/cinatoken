import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migration = readFileSync(fileURLToPath(new URL(
	'../../migrations-d1/0056_request_session_id.sql', import.meta.url,
).href), 'utf8');

test('D1 session migration accepts 256 Unicode characters and rejects empty or oversized values', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec('CREATE TABLE api_key_request_logs (id TEXT PRIMARY KEY)');
		database.exec(migration);
		database.prepare('INSERT INTO api_key_request_logs (id, session_id) VALUES (?, ?)')
			.run('valid', '🧭'.repeat(256));
		assert.equal(
			database.prepare('SELECT session_id FROM api_key_request_logs WHERE id = ?')
				.get('valid')?.session_id,
			'🧭'.repeat(256),
		);
		assert.throws(
			() => database.prepare('INSERT INTO api_key_request_logs (id, session_id) VALUES (?, ?)')
				.run('empty', ''),
			/CHECK constraint failed/u,
		);
		assert.throws(
			() => database.prepare('INSERT INTO api_key_request_logs (id, session_id) VALUES (?, ?)')
				.run('too-long', 'x'.repeat(257)),
			/CHECK constraint failed/u,
		);
	} finally {
		database.close();
	}
});
