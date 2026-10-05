/** Byte caps applied inside each export scan query before any audit text crosses the DB boundary. */
export const USER_AUDIT_EXPORT_TEXT_LIMITS = {
	id: 512,
	userId: 512,
	apiKeyId: 512,
	requestLogId: 512,
	correlationId: 512,
	actorId: 512,
	userEmail: 320,
	eventType: 256,
	source: 256,
	reasonCode: 256,
	actorType: 256,
	reasonText: 2_048,
	userSnapshot: 8_192,
	createdAt: 64,
} as const;

/** Per SELECT server-side budget for MySQL and PostgreSQL export scans. D1 has no equivalent binding option. */
export const USER_AUDIT_EXPORT_QUERY_TIMEOUT_MS = 5_000;
