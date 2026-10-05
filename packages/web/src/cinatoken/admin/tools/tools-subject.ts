/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createCinaTokenCookieTransport } from '../../api'
import { authCheckSchema } from '../../contracts'
import { ToolSubjectError } from './tools-errors'

export const TOOL_CONSOLE_SUBJECT_HEADER =
	'X-CinaToken-Expected-Console-Subject'
export type ToolRequestOptions = { signal?: AbortSignal; timeoutMs?: number }
export type ToolBoundOptions = ToolRequestOptions & {
	expectedConsoleSubject: string
}
export function createToolSubjectGate(request: typeof fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	return async (options: ToolBoundOptions): Promise<string> => {
		try {
			const subject = options.expectedConsoleSubject
			if (
				!subject ||
				subject.length > 600 ||
				subject.trim() !== subject ||
				/[\p{Cc}\p{Cf}]/u.test(subject)
			)
				throw new ToolSubjectError()
			const encoded = encodeURIComponent(subject)
			options.signal?.throwIfAborted()
			const check = await send('/api/auth/check', authCheckSchema, {}, options)
			options.signal?.throwIfAborted()
			if (
				!check.authenticated ||
				check.verification !== 'verified' ||
				check.principalType !== 'console' ||
				check.subject !== subject
			)
				throw new ToolSubjectError()
			return encoded
		} catch {
			throw new ToolSubjectError()
		}
	}
}
