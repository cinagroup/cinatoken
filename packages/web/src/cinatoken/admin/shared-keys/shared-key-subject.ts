/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createCinaTokenCookieTransport } from '../../api'
import { authCheckSchema } from '../../contracts'
import { AdminSharedKeySubjectError } from './shared-key-errors'

export const SHARED_KEY_CONSOLE_SUBJECT_HEADER =
	'X-CinaToken-Expected-Console-Subject'
export type AdminSharedKeyBoundOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	expectedConsoleSubject: string
}
export function createAdminSharedKeySubjectGate(request: typeof fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	return async (options: AdminSharedKeyBoundOptions): Promise<string> => {
		try {
			const expected = options.expectedConsoleSubject
			if (
				typeof expected !== 'string' ||
				!expected ||
				expected.length > 600 ||
				expected.trim() !== expected ||
				/[\p{Cc}\p{Cf}]/u.test(expected)
			)
				throw new AdminSharedKeySubjectError()
			const encoded = encodeURIComponent(expected)
			options.signal?.throwIfAborted()
			const check = await send(
				'/api/auth/check',
				authCheckSchema,
				{},
				{ signal: options.signal, timeoutMs: options.timeoutMs }
			)
			options.signal?.throwIfAborted()
			if (
				!check.authenticated ||
				check.verification !== 'verified' ||
				check.principalType !== 'console' ||
				check.subject !== expected
			)
				throw new AdminSharedKeySubjectError()
			return encoded
		} catch {
			throw new AdminSharedKeySubjectError()
		}
	}
}
