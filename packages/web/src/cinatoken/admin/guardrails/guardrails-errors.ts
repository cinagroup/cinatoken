/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminDomainWriteError } from '../domain-write-recovery'

function status(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}

function invalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function adminGuardrailAccessLost(error: unknown): boolean {
	return (
		status(error) === 401 || status(error) === 403 || invalidResponse(error)
	)
}

export function adminGuardrailWriteUncertain(error: unknown): boolean {
	if (error instanceof AdminDomainWriteError)
		return error.code === 'unknown' || error.code === 'storage'
	const code = status(error)
	return code === 0 || code >= 500 || invalidResponse(error)
}

export function adminGuardrailWriteRejected(error: unknown): boolean {
	if (error instanceof AdminDomainWriteError) return error.code === 'rejected'
	const code = status(error)
	return code === 404 || code === 409
}

export function adminGuardrailErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminGuardrails.'
	if (invalidResponse(error)) return prefix + 'invalidResponse'
	if (adminGuardrailAccessLost(error)) return prefix + 'accessDenied'
	const code = status(error)
	if (code === 400 || code === 413) return prefix + 'invalidInput'
	if (code === 404) return prefix + 'notFound'
	if (code === 409) return prefix + 'conflict'
	return prefix + 'requestFailed'
}
