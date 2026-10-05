/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import type { UsersRequestOptions } from '../users/users-api'
import {
	adminSharedKeyAuditCursorSchema,
	adminSharedKeyAuditResponseSchema,
} from './audit-contracts'
import {
	decodeSharedKeyAuditCursor,
	validSharedKeyAuditPage,
} from './audit-cursor'
import { adminSharedKeyIdSchema } from './shared-key-contracts'
import {
	AdminSharedKeyInputError,
	sanitizeSharedKeyError,
} from './shared-key-errors'

export function createAdminSharedKeyAuditApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	return {
		async adminSharedKeyAudit(
			id: string,
			cursor: string | null,
			options: UsersRequestOptions = {}
		) {
			const boundary =
				cursor === null ? null : decodeSharedKeyAuditCursor(cursor, id)
			if (
				!adminSharedKeyIdSchema.safeParse(id).success ||
				(cursor !== null &&
					(!adminSharedKeyAuditCursorSchema.safeParse(cursor).success ||
						boundary === null))
			)
				throw new AdminSharedKeyInputError()
			const query = new URLSearchParams({ page_size: '20' })
			if (cursor !== null) query.set('cursor', cursor)
			try {
				const result = await send(
					'/api/admin/shared-keys/' +
						encodeURIComponent(id) +
						'/audit?' +
						query.toString(),
					adminSharedKeyAuditResponseSchema,
					{},
					{ signal: options.signal, timeoutMs: options.timeoutMs }
				)
				const page = result.data
				if (!validSharedKeyAuditPage(page, id, boundary))
					throw new CinaTokenApiError(
						'Shared key audit response is invalid',
						200,
						'invalid-response'
					)
				return page
			} catch (error) {
				throw sanitizeSharedKeyError(error)
			}
		},
	}
}
