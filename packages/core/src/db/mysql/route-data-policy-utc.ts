import type { MySqlConnectionLike, MySqlPoolLike } from './mysql2-compat';

type OwnedConnection = MySqlConnectionLike & { destroy(): void };

/** Target repository owns the session exclusively; no pool-level SET or non-UTC fallback. */
export async function withPolicyUtcConnection<T>(
	pool: MySqlPoolLike,
	run: (connection: OwnedConnection) => Promise<T>,
	transactional = false,
): Promise<T> {
	if (typeof pool.getConnection !== 'function') throw new Error('Route data policy requires an owned MySQL connection');
	const connection = (await pool.getConnection()) as OwnedConnection;
	if (typeof connection.destroy !== 'function') {
		connection.release();
		throw new Error('Route data policy requires a disposable MySQL connection');
	}
	let original: string | undefined;
	let restore = false;
	let usable = true;
	let transaction = false;
	let result: T | undefined;
	let failed = false;
	let failure: unknown;
	try {
		const [rows] = await connection.query<{ policy_time_zone: string }[]>('SELECT @@session.time_zone AS policy_time_zone');
		original = rows.length === 1 ? rows[0]?.policy_time_zone : undefined;
		if (typeof original !== 'string' || !/^(?:[+-]\d{2}:\d{2}|[A-Za-z][A-Za-z0-9_./+-]{0,127})$/u.test(original)) {
			usable = false;
			throw new Error('Invalid MySQL policy session timezone');
		}
		if (original !== '+00:00') {
			restore = true;
			await connection.query('SET SESSION time_zone = ?', ['+00:00']);
		}
		if (transactional) {
			// If BEGIN's acknowledgement is lost, rollback/destroy before any release.
			transaction = true;
			await connection.beginTransaction();
		}
		result = await run(connection);
		if (transactional) {
			await connection.commit();
			transaction = false;
		}
	} catch (error) {
		failed = true;
		failure = error;
		if (original === undefined) usable = false;
		if (transaction) {
			try {
				await connection.rollback();
			} catch {
				usable = false;
			}
		}
	} finally {
		try {
			if (usable && restore) {
				try {
					await connection.query('SET SESSION time_zone = ?', [original]);
				} catch {
					usable = false;
					failed = true;
					failure = new Error('Could not restore MySQL policy session timezone');
				}
			}
		} finally {
			if (usable) connection.release();
			else connection.destroy();
		}
	}
	if (failed) throw failure;
	return result as T;
}
