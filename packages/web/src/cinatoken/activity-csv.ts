import type { ActivityCsvExport } from './activity-contracts'

export const ACTIVITY_EXPORT_WORKSPACE_HEADER = 'X-CinaToken-Workspace-Id'
export const ACTIVITY_EXPORT_MAX_BYTES = 32 * 1024 * 1024

function invalid(): never {
	throw new TypeError('Server returned an invalid Activity export')
}

/** Read the exact quoted CSV format emitted by the server, including embedded commas and newlines. */
function csvRows(value: string): string[][] {
	const text = value.startsWith('\uFEFF') ? value.slice(1) : value
	const rows: string[][] = []
	let position = 0
	while (position < text.length) {
		const row: string[] = []
		let ended = false
		while (!ended) {
			if (text[position++] !== '"') invalid()
			let cell = ''
			let closed = false
			while (position < text.length) {
				const character = text[position++]
				if (character !== '"') {
					cell += character
					continue
				}
				if (text[position] === '"') {
					cell += '"'
					position++
					continue
				}
				closed = true
				break
			}
			if (!closed) invalid()
			row.push(cell)
			if (text[position] === ',') {
				position++
				continue
			}
			if (text.slice(position, position + 2) !== '\r\n') invalid()
			position += 2
			ended = true
		}
		rows.push(row)
		if (rows.length > 1001) invalid()
	}
	return rows
}

function headerCount(headers: Headers, name: string): number {
	const raw = headers.get(name)
	if (raw === null || !/^(?:0|[1-9]\d*)$/u.test(raw)) invalid()
	const value = Number(raw)
	if (!Number.isSafeInteger(value)) invalid()
	return value
}

export async function readActivityCsvResponse(
	response: Response
): Promise<ActivityCsvExport> {
	if (!/^text\/csv(?:;|$)/iu.test(response.headers.get('Content-Type') ?? ''))
		invalid()
	const encodedWorkspace = response.headers.get(
		ACTIVITY_EXPORT_WORKSPACE_HEADER
	)
	if (!encodedWorkspace) invalid()
	let workspaceId: string
	try {
		workspaceId = decodeURIComponent(encodedWorkspace)
	} catch {
		return invalid()
	}
	const billingCurrency =
		response.headers.get('X-CinaToken-Billing-Currency') ?? ''
	if (!/^[A-Z]{3}$/u.test(billingCurrency)) invalid()
	const rowCount = headerCount(response.headers, 'X-CinaToken-Export-Count')
	const total = headerCount(response.headers, 'X-CinaToken-Export-Total')
	const rawTruncated = response.headers.get('X-CinaToken-Export-Truncated')
	if (rawTruncated !== 'true' && rawTruncated !== 'false') invalid()
	const truncated = rawTruncated === 'true'
	if (rowCount > 1000 || total < rowCount || truncated !== total > rowCount)
		invalid()
	const disposition = response.headers.get('Content-Disposition') ?? ''
	const matched =
		/^attachment;\s*filename="(cinatoken-activity-(\d{4}-\d{2}-\d{2})\.csv)"$/u.exec(
			disposition
		)
	if (
		!matched ||
		!Number.isFinite(Date.parse(`${matched[2]}T00:00:00.000Z`)) ||
		new Date(`${matched[2]}T00:00:00.000Z`).toISOString().slice(0, 10) !==
			matched[2]
	)
		invalid()
	const blob = await response.blob()
	if (blob.size > ACTIVITY_EXPORT_MAX_BYTES) invalid()
	const bytes = await blob.arrayBuffer()
	const rows = csvRows(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	const columns = [
		'time',
		'request_id',
		'api_key_id',
		'api_key_name',
		'model_id',
		'model_name',
		'provider_name',
		'protocol',
		'operation',
		'status',
		'input_tokens',
		'output_tokens',
		'total_tokens',
		'input_image_count',
		'output_image_count',
		'audio_duration_seconds',
		'audio_characters',
		`charged_cost_${billingCurrency.toLowerCase()}`,
		'latency_ms',
		'billing_kind',
	]
	if (
		rows.length !== rowCount + 1 ||
		rows[0].length !== columns.length ||
		rows[0].some((column, index) => column !== columns[index])
	)
		invalid()
	if (
		rows
			.slice(1)
			.some(
				(row) =>
					row.length !== columns.length ||
					row.some((cell) => /^[=+\-@]/u.test(cell))
			)
	)
		invalid()
	return {
		blob,
		filename: matched[1],
		rowCount,
		total,
		truncated,
		billingCurrency,
		workspaceId,
	}
}
