/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'
import { ToolRejectedError } from './tools-rejection'

export class ToolInputError extends Error {
	constructor() {
		super('Tool input is invalid')
		this.name = 'ToolInputError'
	}
}
export class ToolPersistenceError extends Error {
	constructor() {
		super('Tool operation marker could not be retained')
		this.name = 'ToolPersistenceError'
	}
}
export class ToolSubjectError extends CinaTokenApiError {
	constructor() {
		super('Verified Console subject could not be confirmed', 403, 'http')
		this.name = 'ToolSubjectError'
	}
}
export class ToolReadError extends CinaTokenApiError {
	constructor(error: CinaTokenApiError) {
		super('Tools read could not be confirmed', error.status, error.code)
		this.name = 'ToolReadError'
	}
}
export function toolAccessDenied(error: unknown): boolean {
	return error instanceof CinaTokenApiError && [401, 403].includes(error.status)
}
export function toolWriteUnknown(error: unknown): boolean {
	if (
		error instanceof ToolInputError ||
		error instanceof ToolPersistenceError ||
		error instanceof ToolSubjectError
	)
		return false
	return (
		!(error instanceof CinaTokenApiError) ||
		error.status === 0 ||
		error.status >= 500 ||
		(error.code === 'business' && error.status >= 200 && error.status < 300) ||
		['network', 'timeout', 'cancelled', 'invalid-response'].includes(error.code)
	)
}
export function sanitizeToolError(error: unknown): CinaTokenApiError {
	if (
		error instanceof ToolSubjectError ||
		error instanceof ToolReadError ||
		error instanceof ToolRejectedError
	)
		return error
	if (error instanceof CinaTokenApiError)
		return new CinaTokenApiError(
			'Tool operation could not be confirmed',
			error.status,
			error.code,
			error.serverCode
		)
	return new CinaTokenApiError(
		'Tool operation could not be confirmed',
		0,
		'network'
	)
}
export function toolErrorKey(error: unknown): string {
	if (error instanceof ToolRejectedError) {
		if (error.rejection === 'tools_activation_required')
			return 'activationRequired'
		if (error.rejection === 'tools_provider_not_ready')
			return 'activeCredentialRequired'
		if (error.rejection === 'tools_loss_pricing_confirmation_required')
			return 'lossRequired'
		if (error.rejection === 'invalid_source') return 'blockedSource'
	}
	if (error instanceof ToolInputError) return 'invalidInput'
	if (error instanceof ToolPersistenceError) return 'storageUnavailable'
	if (toolAccessDenied(error)) return 'accessDenied'
	if (error instanceof CinaTokenApiError) {
		if (error.status === 409) return 'conflict'
		if (error.status === 428) return 'versionRequired'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'requestFailed'
}
