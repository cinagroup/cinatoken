import { Hono } from "hono";
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	effectiveRouteDataPolicyStatusForSubject,
	routeDataPolicySubjectMatches,
	type RouteDataPolicyStatus,
	RouteDataPolicyWriteConflictError,
} from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { hasAdminPermission } from "@/lib/admin-principal";
import {
	adminDomainContract,
	domainAcknowledgement,
} from "@/lib/services/admin/domain-contract";
import {
	currentPolicyFingerprint,
	parseDataPolicyClientPrecondition,
} from "@/lib/services/admin/data-policy-precondition";

export const adminDataPoliciesRoutes = new Hono<AdminEnv>();

adminDataPoliciesRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminDataPoliciesRoutes.use("*", adminDomainContract);

function flag(value: number | boolean): boolean {
	return value === true || value === 1;
}
function snapshot(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}
type AdminPolicyRow = Awaited<
	ReturnType<
		AdminEnv["Variables"]["repositories"]["routeDataPolicies"]["listAll"]
	>
>[number];

function response(
	row: AdminPolicyRow,
	currentSubjectFingerprint: string | null
) {
	return {
		...row,
		current_subject_fingerprint: currentSubjectFingerprint,
		training_allowed: flag(row.training_allowed),
		zdr_supported: flag(row.zdr_supported),
		subject_matches_current: routeDataPolicySubjectMatches(
			row,
			currentSubjectFingerprint
		),
		effective_status: effectiveRouteDataPolicyStatusForSubject(
			row,
			currentSubjectFingerprint
		),
	};
}

async function currentSubject(
	repositories: AdminEnv["Variables"]["repositories"],
	routeTargetId: string
) {
	const route = await repositories.routes.getModelRouteRowById(routeTargetId);
	if (!route) return null;
	const provider = await repositories.providers.getProviderById(
		route.provider_id
	);
	if (!provider) return null;
	return {
		route,
		provider,
		fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(
			route,
			provider
		),
	};
}

adminDataPoliciesRoutes.get("/", async (c) => {
	const repositories = c.get("repositories");
	const rows = await repositories.routeDataPolicies.listAll();
	const data = await Promise.all(
		rows.map(async (row) => {
			const [subject, policy] = await Promise.all([
				currentSubject(repositories, row.route_target_id),
				repositories.routeDataPolicies.getByRouteTargetId(row.route_target_id),
			]);
			const current = policy ?? {
				route_target_id: row.route_target_id,
				subject_fingerprint: null,
				retention_days: null,
				training_allowed: true,
				zdr_supported: false,
				evidence_url: null,
				verified_by: null,
				verified_at: null,
				expires_at: null,
				status: "unknown" as const,
				invalidated_at: null,
				invalidation_reason: null,
				updated_at: row.updated_at,
			};
			const labels = subject
				? {
						model_id: subject.route.model_id,
						provider_id: subject.provider.id,
						provider_name: subject.provider.name,
						provider_model_name: subject.route.provider_model_name,
						upstream_protocol: subject.route.upstream_protocol,
						upstream_operation: subject.route.upstream_operation ?? null,
						route_group: subject.route.route_group ?? null,
				  }
				: row;
			return {
				...response(
					{ ...row, ...labels, ...current },
					subject?.fingerprint ?? null
				),
				current_policy_fingerprint: await currentPolicyFingerprint(policy),
			};
		})
	);
	return c.json({
		success: true,
		data,
		canWrite: hasAdminPermission(c.get("principal"), "routes.write"),
	});
});

adminDataPoliciesRoutes.get("/:routeTargetId/audit", async (c) => {
	const rows = await c
		.get("repositories")
		.routeDataPolicies.listAudit(c.req.param("routeTargetId"));
	return c.json({
		success: true,
		data: rows.map((row) => ({
			...row,
			snapshot: snapshot(row.snapshot_json),
			snapshot_json: undefined,
		})),
	});
});

adminDataPoliciesRoutes.put("/:routeTargetId", async (c) => {
	const routeTargetId = c.req.param("routeTargetId");
	if (!(await c.get("repositories").routes.getModelRouteRowById(routeTargetId)))
		return c.json({ success: false, message: "Route target not found" }, 404);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body)
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	const unsupported = Object.keys(body).filter(
		(key) =>
			![
				"status",
				"retention_days",
				"training_allowed",
				"zdr_supported",
				"evidence_url",
				"expires_at",
				"expected_subject_fingerprint",
				"expected_policy_fingerprint",
			].includes(key)
	);
	if (unsupported.length > 0)
		return c.json(
			{
				success: false,
				message: `Unsupported field(s): ${unsupported.join(", ")}`,
			},
			400
		);
	const condition = parseDataPolicyClientPrecondition(body);
	if (condition === "invalid")
		return c.json(
			{
				success: false,
				code: "invalid_data_policy_precondition",
				message: "Invalid data policy precondition",
			},
			400
		);
	if (
		!condition &&
		c.env?.CINATOKEN_ADMIN_DATA_POLICIES_REQUIRE_PRECONDITION === "true"
	)
		return c.json(
			{
				success: false,
				code: "data_policy_precondition_required",
				message: "A data policy precondition is required",
			},
			428
		);
	const status = body.status as RouteDataPolicyStatus;
	if (!["verified", "expired", "unknown"].includes(status))
		return c.json(
			{
				success: false,
				message: "status must be verified, expired, or unknown",
			},
			400
		);
	const retentionDays =
		body.retention_days === null || body.retention_days === undefined
			? null
			: Number(body.retention_days);
	if (
		retentionDays !== null &&
		(!Number.isInteger(retentionDays) ||
			retentionDays < 0 ||
			retentionDays > 36500)
	)
		return c.json(
			{
				success: false,
				message: "retention_days must be null or an integer from 0 to 36500",
			},
			400
		);
	if (
		typeof body.training_allowed !== "boolean" ||
		typeof body.zdr_supported !== "boolean"
	)
		return c.json(
			{
				success: false,
				message: "training_allowed and zdr_supported must be booleans",
			},
			400
		);
	let evidenceUrl: string | null = null;
	if (
		body.evidence_url !== undefined &&
		body.evidence_url !== null &&
		typeof body.evidence_url !== "string"
	)
		return c.json(
			{
				success: false,
				message: "evidence_url must be null or a credential-free HTTPS URL",
			},
			400
		);
	if (typeof body.evidence_url === "string" && body.evidence_url.trim()) {
		try {
			const url = new URL(body.evidence_url.trim());
			if (url.protocol !== "https:" || url.username || url.password)
				throw new Error();
			evidenceUrl = url.toString();
		} catch {
			return c.json(
				{
					success: false,
					message: "evidence_url must be a credential-free HTTPS URL",
				},
				400
			);
		}
	}
	let expiresAt: string | null = null;
	if (
		body.expires_at !== undefined &&
		body.expires_at !== null &&
		body.expires_at !== ""
	) {
		if (
			typeof body.expires_at !== "string" ||
			!Number.isFinite(Date.parse(body.expires_at))
		)
			return c.json(
				{
					success: false,
					message: "expires_at must be null or a valid date-time",
				},
				400
			);
		expiresAt = new Date(body.expires_at).toISOString();
	}
	const nowIso = new Date().toISOString();
	if (
		status === "verified" &&
		(!evidenceUrl || !expiresAt || Date.parse(expiresAt) <= Date.now())
	)
		return c.json(
			{
				success: false,
				message:
					"Verified policy requires evidence_url and a future expires_at",
			},
			400
		);
	const actorId = c.get("principal").id;
	const repositories = c.get("repositories");
	const route = await repositories.routes.getModelRouteRowById(routeTargetId);
	if (!route)
		return c.json({ success: false, message: "Route target not found" }, 404);
	const provider = await repositories.providers.getProviderById(
		route.provider_id
	);
	if (!provider)
		return c.json(
			{ success: false, message: "Route target provider not found" },
			409
		);
	const subjectFingerprint =
		await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
	const priorPolicy = condition
		? await repositories.routeDataPolicies.getByRouteTargetId(routeTargetId)
		: null;
	if (
		condition &&
		(condition.expected_subject_fingerprint !== subjectFingerprint ||
			condition.expected_policy_fingerprint !==
				(await currentPolicyFingerprint(priorPolicy)))
	)
		return c.json(
			{
				success: false,
				code: "route_data_policy_write_conflict",
				message: "Data policy subject or current policy changed; review again",
			},
			409
		);
	let row;
	try {
		row = await repositories.routeDataPolicies.upsertWithAudit({
			id: crypto.randomUUID(),
			routeTargetId,
			subjectFingerprint,
			retentionDays,
			trainingAllowed: body.training_allowed,
			zdrSupported: body.zdr_supported,
			evidenceUrl,
			verifiedBy: status === "verified" ? actorId : null,
			verifiedAt: status === "verified" ? nowIso : null,
			expiresAt,
			status,
			actorId,
			nowIso,
			...(condition
				? {
						precondition: {
							currentSubjectFingerprint: subjectFingerprint,
							subjectReadSet: { route, provider },
							priorPolicy,
						},
				  }
				: {}),
		});
	} catch (error) {
		if (error instanceof RouteDataPolicyWriteConflictError)
			return c.json(
				{
					success: false,
					code: error.code,
					message:
						"Data policy subject or current policy changed; review again",
				},
				409
			);
		throw error;
	}
	return c.json({
		success: true,
		data: response(
			{
				...row,
				model_id: "",
				provider_id: "",
				provider_name: "",
				provider_model_name: "",
				upstream_protocol: "",
				upstream_operation: null,
				route_group: null,
			},
			subjectFingerprint
		),
		acknowledgement: domainAcknowledgement(
			"data-policies",
			"update",
			routeTargetId
		),
	});
});
