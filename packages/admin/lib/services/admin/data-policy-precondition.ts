import type { RouteDataPolicyRow } from "@octafuse/core";

/** Hash only the complete policy read-set, with flags normalized across drivers. */
export async function currentPolicyFingerprint(
	row: RouteDataPolicyRow | null
): Promise<string | null> {
	if (!row) return null;
	const values = [
		row.route_target_id,
		row.subject_fingerprint,
		row.retention_days,
		row.training_allowed === true || row.training_allowed === 1,
		row.zdr_supported === true || row.zdr_supported === 1,
		row.evidence_url,
		row.verified_by,
		row.verified_at,
		row.expires_at,
		row.status,
		row.invalidated_at,
		row.invalidation_reason,
		row.updated_at,
	];
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify(["cinatoken.route-data-policy-current.v1", ...values])
		)
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export type DataPolicyClientPrecondition = {
	expected_subject_fingerprint: string;
	expected_policy_fingerprint: string | null;
};

export function parseDataPolicyClientPrecondition(
	body: Record<string, unknown>
): DataPolicyClientPrecondition | null | "invalid" {
	const subject = Object.hasOwn(body, "expected_subject_fingerprint");
	const policy = Object.hasOwn(body, "expected_policy_fingerprint");
	if (!subject && !policy) return null;
	if (!subject || !policy) return "invalid";
	if (
		typeof body.expected_subject_fingerprint !== "string" ||
		!/^[0-9a-f]{64}$/u.test(body.expected_subject_fingerprint)
	)
		return "invalid";
	if (
		body.expected_policy_fingerprint !== null &&
		(typeof body.expected_policy_fingerprint !== "string" ||
			!/^[0-9a-f]{64}$/u.test(body.expected_policy_fingerprint))
	)
		return "invalid";
	return {
		expected_subject_fingerprint: body.expected_subject_fingerprint,
		expected_policy_fingerprint: body.expected_policy_fingerprint,
	};
}
