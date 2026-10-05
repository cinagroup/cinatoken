import { computeRouteDataPolicySubjectFingerprintFromRows } from '../route-data-policy';
import {
	RouteDataPolicyWriteConflictError,
	type RouteDataPolicyRow,
	type RouteDataPolicyWritePrecondition,
	type UpsertRouteDataPolicyParams,
} from './route-data-policy-types';

export type PolicySqlDriver = 'd1' | 'postgres' | 'mysql';
export type PolicySqlCondition = { sql: string; values: unknown[] };
export const POLICY_COLUMNS = [
	'route_target_id',
	'subject_fingerprint',
	'retention_days',
	'training_allowed',
	'zdr_supported',
	'evidence_url',
	'verified_by',
	'verified_at',
	'expires_at',
	'status',
	'invalidated_at',
	'invalidation_reason',
	'updated_at',
] as const;
const dates = new Set<string>(['verified_at', 'expires_at', 'invalidated_at', 'updated_at']);
const numeric = new Set<string>(['retention_days', 'training_allowed', 'zdr_supported']);

/** Keep all six SQL timestamp digits. Date.parse/toISOString would discard the last three. */
export function policyMySqlDate(value: string | null): string | null {
	if (value === null) return null;
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u.exec(value);
	if (!match || !Number.isFinite(Date.parse(value))) throw new RouteDataPolicyWriteConflictError();
	if (new Date(value).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) throw new RouteDataPolicyWriteConflictError();
	return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
}

/** Fingerprint equality is checked before SQL; the exact underlying rows are checked at commit. */
export async function assertPolicyPrecondition(params: UpsertRouteDataPolicyParams): Promise<void> {
	const expected = params.precondition;
	if (expected === undefined) return;
	if (
		!expected ||
		!/^[0-9a-f]{64}$/u.test(expected.currentSubjectFingerprint) ||
		expected.currentSubjectFingerprint !== params.subjectFingerprint ||
		!expected.subjectReadSet ||
		!expected.subjectReadSet.route ||
		!expected.subjectReadSet.provider ||
		expected.subjectReadSet.route.id !== params.routeTargetId ||
		expected.subjectReadSet.route.provider_id !== expected.subjectReadSet.provider.id ||
		(expected.priorPolicy !== null &&
			(!expected.priorPolicy ||
				!POLICY_COLUMNS.every((key) => Object.hasOwn(expected.priorPolicy!, key)) ||
				expected.priorPolicy.route_target_id !== params.routeTargetId))
	)
		throw new RouteDataPolicyWriteConflictError();
	try {
		const computed = await computeRouteDataPolicySubjectFingerprintFromRows(
			expected.subjectReadSet.route,
			expected.subjectReadSet.provider,
		);
		if (computed !== expected.currentSubjectFingerprint) throw new RouteDataPolicyWriteConflictError();
	} catch {
		throw new RouteDataPolicyWriteConflictError();
	}
}

function equal(driver: PolicySqlDriver, column: string, index: number, scalar = false): string {
	if (driver === 'd1') return `${column} COLLATE BINARY IS ?`;
	if (driver === 'mysql') return scalar ? `${column} <=> ?` : `BINARY ${column} <=> BINARY ?`;
	return scalar ? `${column} IS NOT DISTINCT FROM $${index}` : `${column} COLLATE "C" IS NOT DISTINCT FROM $${index} COLLATE "C"`;
}

export function policySubjectCondition(expected: RouteDataPolicyWritePrecondition, driver: PolicySqlDriver, start = 1): PolicySqlCondition {
	const route = expected.subjectReadSet.route;
	const provider = expected.subjectReadSet.provider;
	const entries: [string, unknown][] = [
		['r.id', route.id],
		['r.provider_id', route.provider_id],
		['r.provider_model_name', route.provider_model_name],
		['r.upstream_protocol', route.upstream_protocol],
		['r.upstream_operation', route.upstream_operation ?? null],
		['r.adapter', route.adapter ?? null],
		['r.custom_params', route.custom_params],
		['pr.id', provider.id],
		['pr.endpoints', provider.endpoints ?? null],
		['pr.api_key', provider.api_key ?? null],
		['pr.shared_channel_type', provider.shared_channel_type ?? null],
	];
	return {
		sql: entries.map(([column], index) => equal(driver, column, start + index)).join(' AND '),
		values: entries.map(([, value]) => value),
	};
}

export function policyPriorCondition(row: RouteDataPolicyRow, driver: PolicySqlDriver, alias: string, start = 1): PolicySqlCondition {
	const values = POLICY_COLUMNS.map((key) => {
		const value = row[key];
		if (key === 'training_allowed' || key === 'zdr_supported') {
			if (![true, false, 0, 1].includes(value as boolean | number)) throw new RouteDataPolicyWriteConflictError();
			return driver === 'postgres' ? value === true || value === 1 : value === true || value === 1 ? 1 : 0;
		}
		return driver === 'mysql' && dates.has(key) ? policyMySqlDate(value as string | null) : value;
	});
	return {
		sql: POLICY_COLUMNS.map((key, index) => equal(driver, `${alias}.${key}`, start + index, numeric.has(key) || dates.has(key))).join(
			' AND ',
		),
		values,
	};
}

export function policySnapshot(params: UpsertRouteDataPolicyParams): string {
	return JSON.stringify({
		v: 2,
		route_target_id: params.routeTargetId,
		subject_fingerprint: params.subjectFingerprint,
		retention_days: params.retentionDays,
		training_allowed: params.trainingAllowed,
		zdr_supported: params.zdrSupported,
		evidence_url: params.evidenceUrl,
		verified_by: params.verifiedBy,
		verified_at: params.verifiedAt,
		expires_at: params.expiresAt,
		status: params.status,
		invalidated_at: null,
		invalidation_reason: null,
	});
}

export function policyWriteValues(params: UpsertRouteDataPolicyParams, driver: PolicySqlDriver): unknown[] {
	return [
		params.routeTargetId,
		params.subjectFingerprint,
		params.retentionDays,
		driver === 'postgres' ? params.trainingAllowed : params.trainingAllowed ? 1 : 0,
		driver === 'postgres' ? params.zdrSupported : params.zdrSupported ? 1 : 0,
		params.evidenceUrl,
		params.verifiedBy,
		driver === 'mysql' ? policyMySqlDate(params.verifiedAt) : params.verifiedAt,
		driver === 'mysql' ? policyMySqlDate(params.expiresAt) : params.expiresAt,
		params.status,
		driver === 'mysql' ? policyMySqlDate(params.nowIso) : params.nowIso,
	];
}
