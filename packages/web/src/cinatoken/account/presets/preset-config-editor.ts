export function readPresetConfig(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text)
		return value !== null && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

/** Convenient edits merge only the changed field; advanced settings remain intact. */
export function presetConfigurationBytes(text: string): number {
	const config = readPresetConfig(text)
	return new TextEncoder().encode(config ? JSON.stringify(config) : text)
		.byteLength
}

export function changePresetField(
	config: Record<string, unknown>,
	key: string,
	value: unknown,
	provider = false
): string {
	const next = { ...config }
	let target = next
	if (provider) {
		const current = next.provider
		target =
			current !== null && typeof current === 'object' && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: {}
		next.provider = target
	}
	if (value === undefined) delete target[key]
	else target[key] = value
	return JSON.stringify(next, null, 2)
}

export function parsePresetNumber(value: string): {
	valid: boolean
	value?: number
} {
	if (!value.trim()) return { valid: true }
	if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim()))
		return { valid: false }
	const number = Number(value)
	return Number.isFinite(number)
		? { valid: true, value: number }
		: { valid: false }
}
