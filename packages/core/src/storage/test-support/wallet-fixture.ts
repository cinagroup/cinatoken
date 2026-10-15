import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Upgrade focused legacy reservation fixtures with the actual appended wallet migration. */
export function applyWalletMigrationToBudgetFixture(database: DatabaseSync): void {
	database.exec(`CREATE TABLE IF NOT EXISTS user_audit_logs (id TEXT PRIMARY KEY, user_id TEXT);
 CREATE TABLE IF NOT EXISTS api_key_request_logs (id TEXT PRIMARY KEY, user_id TEXT, budget_charged_micros INTEGER NOT NULL DEFAULT 0);`);
	const columns = database.prepare('PRAGMA table_info(api_key_request_logs)').all();
	if (!columns.some((column) => column.name === 'budget_charged_micros'))
		database.exec('ALTER TABLE api_key_request_logs ADD COLUMN budget_charged_micros INTEGER NOT NULL DEFAULT 0');
	database.exec(readFileSync(new URL('../../../migrations-d1/0078_user_wallet_credit.sql', import.meta.url), 'utf8'));
	database.exec(
		'ALTER TABLE users ADD COLUMN rate_limit TEXT; ALTER TABLE api_keys ADD COLUMN rate_limit TEXT; ALTER TABLE api_key_request_logs ADD COLUMN ingress_host TEXT;',
	);
}
