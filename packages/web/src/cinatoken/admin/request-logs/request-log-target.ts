/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const requestLogIdSchema = z
	.string()
	.min(1)
	.max(255)
	.refine((value) => {
		if (
			/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value) ||
			/^(?:sk-|enc:v[12]:|sha256:)/u.test(value)
		)
			return false
		try {
			encodeURIComponent(value)
			return true
		} catch {
			return false
		}
	})
export function requestLogTargetHref(id: string): string {
	return (
		'/admin/request-logs?' +
		new URLSearchParams({ request_id: requestLogIdSchema.parse(id) })
	)
}
