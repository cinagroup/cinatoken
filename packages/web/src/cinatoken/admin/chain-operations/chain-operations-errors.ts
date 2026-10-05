/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'

export class ChainOperationError extends Error {
	constructor(
		readonly causeCode:
			'input' | 'subject' | 'rejected' | 'unknown' | 'storage',
		readonly status = 0
	) {
		super('Chain operation could not be confirmed')
		this.name = 'ChainOperationError'
	}
}
export function chainAccessDenied(error: unknown): boolean {
	return (
		(error instanceof CinaTokenApiError &&
			(error.status === 401 || error.status === 403)) ||
		(error instanceof ChainOperationError &&
			(error.causeCode === 'subject' ||
				error.status === 401 ||
				error.status === 403))
	)
}
export function chainWriteErrorKey(error: unknown): string {
	if (chainAccessDenied(error)) return 'accessDenied'
	if (error instanceof ChainOperationError) {
		if (error.causeCode === 'input') return 'invalidInput'
		if (error.causeCode === 'unknown') return 'unknownWrite'
		if (error.causeCode === 'storage') return 'storageUnavailable'
		if (error.status === 409) return 'rejectionConflict'
		if (error.status === 404) return 'notFound'
	}
	return 'writeFailed'
}
export function sanitizeChainReadError(error: unknown): Error {
	if (error instanceof CinaTokenApiError)
		return new CinaTokenApiError(
			'Chain records could not be read',
			error.status,
			error.code
		)
	return new Error('Chain records could not be read')
}
