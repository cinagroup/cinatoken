/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function validateChatSearch(input: Record<string, unknown>): {
	model: string
} {
	const value = input.model
	const valid =
		typeof value === 'string' &&
		value.length <= 180 &&
		value.trim() === value &&
		!Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		)
	return { model: valid ? value : '' }
}
