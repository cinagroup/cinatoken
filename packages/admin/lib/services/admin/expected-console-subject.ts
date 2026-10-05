import type { AdminPrincipal } from "@/lib/admin-principal";
import { cinaAuthSubjectFromPrincipal } from "@/lib/cinaauth/principal";

export const EXPECTED_CONSOLE_SUBJECT_HEADER =
	"X-CinaToken-Expected-Console-Subject";

export class ExpectedConsoleSubjectError extends Error {
	constructor(
		public readonly status: 400 | 403 | 428,
		public readonly code:
			| "invalid_console_subject_precondition"
			| "console_subject_mismatch"
			| "console_subject_required",
		message: string
	) {
		super(message);
	}
}

function invalid(): never {
	throw new ExpectedConsoleSubjectError(
		400,
		"invalid_console_subject_precondition",
		"Invalid Console subject precondition"
	);
}

/** A caller supplies only a precondition; the authenticated principal remains the audit actor. */
export function assertExpectedConsoleSubject(
	principal: AdminPrincipal,
	header: string | null | undefined,
	required = false
): void {
	if (header === null || header === undefined) {
		if (required && principal.type === "console")
			throw new ExpectedConsoleSubjectError(
				428,
				"console_subject_required",
				"A Console subject precondition is required"
			);
		return;
	}
	if (principal.type !== "console" || header.length > 5400) invalid();
	let expected: string;
	try {
		// Exactly one canonical encoding layer. Literal percent sequences are valid opaque subjects.
		expected = decodeURIComponent(header);
		if (encodeURIComponent(expected) !== header) invalid();
	} catch {
		invalid();
	}
	if (
		!expected ||
		expected.length > 600 ||
		expected.trim() !== expected ||
		/[\p{Cc}\p{Cf}]/u.test(expected)
	)
		invalid();
	const trusted = cinaAuthSubjectFromPrincipal(principal);
	if (
		!trusted ||
		principal.id !== `console:${principal.username}` ||
		trusted !== expected
	)
		throw new ExpectedConsoleSubjectError(
			403,
			"console_subject_mismatch",
			"Console subject changed; review the operation again"
		);
}
