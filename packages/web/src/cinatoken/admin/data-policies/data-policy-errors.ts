/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminDomainWriteError } from '../domain-write-recovery'
import { DataPolicyFormError } from './data-policy-form'

export function dataPolicyErrorStatus(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}

export function dataPolicyAccessDenied(error: unknown): boolean {
	const status = dataPolicyErrorStatus(error)
	return status === 401 || status === 403
}

export function dataPolicyInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function dataPolicyWriteUncertain(error: unknown): boolean {
	if (error instanceof AdminDomainWriteError)
		return error.code === 'unknown' || error.code === 'storage'
	if (error instanceof DataPolicyFormError) return false
	const status = dataPolicyErrorStatus(error)
	return (
		status === 0 ||
		status === 404 ||
		status === 409 ||
		status >= 500 ||
		dataPolicyInvalidResponse(error)
	)
}

export function dataPolicyErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminDataPolicies.'
	if (error instanceof AdminDomainWriteError) {
		if (error.code === 'storage')
			return 'cinatoken.adminDomain.storageUnavailable'
		if (error.code === 'subject') return prefix + 'accessDenied'
		if (
			error.serverCode === 'invalid_data_policy_precondition' ||
			error.serverCode === 'data_policy_precondition_required'
		)
			return prefix + 'precondition'
	}
	if (error instanceof DataPolicyFormError) return prefix + error.code
	if (dataPolicyAccessDenied(error)) return prefix + 'accessDenied'
	if (dataPolicyInvalidResponse(error)) return prefix + 'invalidResponse'
	const status = dataPolicyErrorStatus(error)
	if (status === 404) return prefix + 'notFound'
	if (status === 409) return prefix + 'conflict'
	if (status === 428) return prefix + 'precondition'
	if (status === 400 || status === 413 || status === 422)
		return prefix + 'invalidInput'
	return prefix + 'requestFailed'
}

/** Only actual uncoded field rejections qualify for draft repair. */
export function dataPolicyCanResumeEditor(error: unknown): boolean {
	return (
		error instanceof AdminDomainWriteError &&
		error.code === 'rejected' &&
		error.serverCode === null &&
		[400, 413, 422].includes(error.status)
	)
}

export function dataPolicyWriteHintKey(error: unknown): string | null {
	if (!(error instanceof AdminDomainWriteError)) return null
	if (error.code === 'unknown')
		return 'cinatoken.adminDataPolicies.writeUnknown'
	if (error.code === 'rejected' && !dataPolicyAccessDenied(error))
		return 'cinatoken.adminDataPolicies.writeRejected'
	return null
}
