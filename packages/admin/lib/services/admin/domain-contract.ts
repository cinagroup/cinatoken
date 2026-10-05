import type { MiddlewareHandler } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import {
	assertExpectedConsoleSubject,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "./expected-console-subject";

export type AdminDomain =
	| "providers"
	| "models"
	| "endpoints"
	| "routes"
	| "presets"
	| "guardrails"
	| "data-policies";
export type AdminDomainOperation =
	| "create"
	| "update"
	| "delete"
	| "import"
	| "resource"
	| "bootstrap"
	| "link"
	| "unlink"
	| "policy"
	| "clear-sticky"
	| "reset-sticky"
	| "designate"
	| "bind"
	| "unbind";

/** Optional on legacy callers; any supplied precondition is strict even on reads/reveal. */
export const adminDomainContract: MiddlewareHandler<AdminEnv> = async (
	c,
	next
) => {
	c.header("Cache-Control", "private, no-store");
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER),
			false
		);
	} catch (error) {
		if (error instanceof ExpectedConsoleSubjectError)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status
			);
		throw error;
	}
	// Domain services retain their existing capacity limits (Provider IDs can
	// exceed 512). This shared boundary only forbids ambiguous normalization.
	for (const value of Object.values(c.req.param()))
		if (
			typeof value !== "string" ||
			!value ||
			value.trim() !== value ||
			/[\p{Cc}\p{Cf}]/u.test(value)
		)
			return c.json(
				{
					success: false,
					code: "invalid_admin_resource_id",
					message: "Invalid resource ID",
				},
				400
			);
	await next();
	c.header("Cache-Control", "private, no-store");
};

/** ACK identifies the request handled, not that every item of a partial import succeeded. */
export function domainAcknowledgement(
	domain: AdminDomain,
	operation: AdminDomainOperation,
	id?: string,
	relatedId?: string
) {
	return {
		domain,
		operation,
		...(id === undefined ? {} : { id }),
		...(relatedId === undefined ? {} : { related_id: relatedId }),
	};
}

export class ModelPolicyPreconditionError extends Error {
	constructor(
		public readonly status: 400 | 409 | 428,
		public readonly code: string,
		message: string
	) {
		super(message);
	}
}
