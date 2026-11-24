import type { MiddlewareHandler } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import {
	assertExpectedConsoleSubject,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "./expected-console-subject";

/** Optional precondition for legacy routes whose resource IDs have their own grammar. */
export const consoleSubjectContract: MiddlewareHandler<AdminEnv> = async (
	c,
	next,
) => {
	c.header("Cache-Control", "private, no-store");
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER),
			false,
		);
	} catch (error) {
		if (error instanceof ExpectedConsoleSubjectError)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status,
			);
		throw error;
	}
	await next();
	c.header("Cache-Control", "private, no-store");
};
