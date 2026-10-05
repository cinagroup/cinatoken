/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	adminEarningReviewInputSchema,
	adminEarningReviewResponseSchema,
	type AdminEarningReviewInput,
} from './review-contracts'
import {
	AdminSharedKeyInputError,
	sanitizeSharedKeyError,
} from './shared-key-errors'
import {
	createAdminSharedKeySubjectGate,
	SHARED_KEY_CONSOLE_SUBJECT_HEADER,
	type AdminSharedKeyBoundOptions,
} from './shared-key-subject'

export function createAdminEarningReviewApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	const verifySubject = createAdminSharedKeySubjectGate(request)
	return {
		async reviewAdminEarnings(
			input: AdminEarningReviewInput,
			apply: boolean,
			options: AdminSharedKeyBoundOptions = { expectedConsoleSubject: '' }
		) {
			const checked = adminEarningReviewInputSchema.safeParse(input)
			if (!checked.success) throw new AdminSharedKeyInputError()
			const query = new URLSearchParams({
				since: checked.data.since,
				limit: String(checked.data.limit),
				apply: apply ? '1' : '0',
			})
			try {
				const subject = await verifySubject(options)
				const result = await send(
					'/api/admin/earnings/rederive?' + query.toString(),
					adminEarningReviewResponseSchema,
					{
						method: 'POST',
						headers: { [SHARED_KEY_CONSOLE_SUBJECT_HEADER]: subject },
					},
					{ signal: options.signal, timeoutMs: options.timeoutMs },
					undefined,
					(response, body) =>
						response.status === 409 &&
						adminEarningReviewResponseSchema.safeParse(body).success &&
						typeof body === 'object' &&
						body !== null &&
						'success' in body &&
						body.success === false
				)
				if (
					result.data.range.since !== checked.data.since ||
					result.data.range.limit !== checked.data.limit ||
					result.dryRun !== !apply ||
					(!result.success && !apply) ||
					(result.success &&
						apply &&
						(!result.data.scanComplete || result.data.candidates !== 0)) ||
					(!result.success &&
						(result.code === 'historical_earning_scan_incomplete') ===
							result.data.scanComplete) ||
					(!result.success &&
						result.code === 'historical_earning_evidence_required' &&
						result.data.candidates === 0)
				)
					throw new CinaTokenApiError(
						'Earnings review response is invalid',
						200,
						'invalid-response'
					)
				return result
			} catch (error) {
				throw sanitizeSharedKeyError(error)
			}
		},
	}
}
