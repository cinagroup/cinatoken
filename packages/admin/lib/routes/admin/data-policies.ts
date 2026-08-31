import { Hono } from 'hono';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	effectiveRouteDataPolicyStatusForSubject,
	routeDataPolicySubjectMatches,
	type RouteDataPolicyStatus,
} from '@octafuse/core';
import type { AdminEnv } from '@/lib/admin-env';

export const adminDataPoliciesRoutes = new Hono<AdminEnv>();

function flag(value: number | boolean): boolean { return value === true || value === 1; }
function snapshot(value: string): unknown {
	try { return JSON.parse(value) as unknown; } catch { return null; }
}
type AdminPolicyRow = Awaited<ReturnType<AdminEnv['Variables']['repositories']['routeDataPolicies']['listAll']>>[number];

function response(row: AdminPolicyRow, currentSubjectFingerprint: string | null) {
	return {
		...row,
		training_allowed: flag(row.training_allowed),
		zdr_supported: flag(row.zdr_supported),
		subject_matches_current: routeDataPolicySubjectMatches(row, currentSubjectFingerprint),
		effective_status: effectiveRouteDataPolicyStatusForSubject(row, currentSubjectFingerprint),
	};
}

async function currentSubjectFingerprint(
	repositories: AdminEnv['Variables']['repositories'],
	routeTargetId: string,
): Promise<string | null> {
	const route = await repositories.routes.getModelRouteRowById(routeTargetId);
	if (!route) return null;
	const provider = await repositories.providers.getProviderById(route.provider_id);
	if (!provider) return null;
	return computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
}

adminDataPoliciesRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const rows = await repositories.routeDataPolicies.listAll();
	const data = await Promise.all(rows.map(async (row) => response(
		row,
		await currentSubjectFingerprint(repositories, row.route_target_id),
	)));
	return c.json({ success: true, data });
});

adminDataPoliciesRoutes.get('/:routeTargetId/audit', async (c) => {
	const rows = await c.get('repositories').routeDataPolicies.listAudit(c.req.param('routeTargetId'));
	return c.json({ success: true, data: rows.map((row) => ({ ...row, snapshot: snapshot(row.snapshot_json), snapshot_json: undefined })) });
});

adminDataPoliciesRoutes.put('/:routeTargetId', async (c) => {
	const routeTargetId = c.req.param('routeTargetId');
	if (!(await c.get('repositories').routes.getModelRouteRowById(routeTargetId))) return c.json({ success: false, message: 'Route target not found' }, 404);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	const unsupported = Object.keys(body).filter((key) => !['status', 'retention_days', 'training_allowed', 'zdr_supported', 'evidence_url', 'expires_at'].includes(key));
	if (unsupported.length > 0) return c.json({ success: false, message: `Unsupported field(s): ${unsupported.join(', ')}` }, 400);
	const status = body.status as RouteDataPolicyStatus;
	if (!['verified', 'expired', 'unknown'].includes(status)) return c.json({ success: false, message: 'status must be verified, expired, or unknown' }, 400);
	const retentionDays = body.retention_days === null || body.retention_days === undefined ? null : Number(body.retention_days);
	if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500)) return c.json({ success: false, message: 'retention_days must be null or an integer from 0 to 36500' }, 400);
	if (typeof body.training_allowed !== 'boolean' || typeof body.zdr_supported !== 'boolean') return c.json({ success: false, message: 'training_allowed and zdr_supported must be booleans' }, 400);
	let evidenceUrl: string | null = null;
	if (body.evidence_url !== undefined && body.evidence_url !== null && typeof body.evidence_url !== 'string') return c.json({ success: false, message: 'evidence_url must be null or a credential-free HTTPS URL' }, 400);
	if (typeof body.evidence_url === 'string' && body.evidence_url.trim()) {
		try { const url = new URL(body.evidence_url.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); evidenceUrl = url.toString(); } catch { return c.json({ success: false, message: 'evidence_url must be a credential-free HTTPS URL' }, 400); }
	}
	let expiresAt: string | null = null;
	if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== '') {
		if (typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) return c.json({ success: false, message: 'expires_at must be null or a valid date-time' }, 400);
		expiresAt = new Date(body.expires_at).toISOString();
	}
	const nowIso = new Date().toISOString();
	if (status === 'verified' && (!evidenceUrl || !expiresAt || Date.parse(expiresAt) <= Date.now())) return c.json({ success: false, message: 'Verified policy requires evidence_url and a future expires_at' }, 400);
	const actorId = c.get('principal').id;
	const subjectFingerprint = await currentSubjectFingerprint(c.get('repositories'), routeTargetId);
	if (!subjectFingerprint) return c.json({ success: false, message: 'Route target provider not found' }, 409);
	const row = await c.get('repositories').routeDataPolicies.upsertWithAudit({
		id: crypto.randomUUID(), routeTargetId, subjectFingerprint, retentionDays, trainingAllowed: body.training_allowed,
		zdrSupported: body.zdr_supported, evidenceUrl, verifiedBy: status === 'verified' ? actorId : null,
		verifiedAt: status === 'verified' ? nowIso : null, expiresAt, status, actorId, nowIso,
	});
	return c.json({ success: true, data: response({ ...row, model_id: '', provider_id: '', provider_name: '', provider_model_name: '', upstream_protocol: '', upstream_operation: null, route_group: null }, subjectFingerprint) });
});
