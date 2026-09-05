/** Parse one SSE `data` field. The single space after `:` is optional per SSE. */
export function parseSseDataLine(line: string): string | null {
	if (!line.startsWith('data:')) return null;
	const value = line.slice(5);
	return value.startsWith(' ') ? value.slice(1) : value;
}

function fieldName(line: string): string {
	const separator = line.indexOf(':');
	return separator < 0 ? line : line.slice(0, separator);
}

function fieldValue(line: string): string {
	const separator = line.indexOf(':');
	if (separator < 0) return '';
	const value = line.slice(separator + 1);
	return value.startsWith(' ') ? value.slice(1) : value;
}

function isDataField(line: string): boolean {
	return fieldName(line) === 'data';
}

/**
 * Parse one complete SSE event according to the EventSource field-folding rule.
 * Repeated `data` fields are joined with a literal newline; comments and other
 * fields do not participate in the payload.
 */
export function parseSseEventData(event: string): string | null {
	const values: string[] = [];
	for (const line of event.split(/\r\n|\r|\n/)) {
		if (line.startsWith(':') || !isDataField(line)) continue;
		values.push(fieldValue(line));
	}
	return values.length > 0 ? values.join('\n') : null;
}

function preferredLineEnding(event: string): '\r\n' | '\r' | '\n' {
	if (event.includes('\r\n')) return '\r\n';
	if (event.includes('\r')) return '\r';
	return '\n';
}

/**
 * Replace all `data` fields while preserving EventSource routing fields such as
 * `event`, `id`, `retry`, and comments. Rewritten events are always terminated
 * by a blank line so clients can dispatch them before the stream closes.
 */
export function rewriteSseEventData(event: string, data: string): string {
	const lineEnding = preferredLineEnding(event);
	const lines = event.split(/\r\n|\r|\n/);
	while (lines.at(-1) === '') lines.pop();

	const rewritten: string[] = [];
	let inserted = false;
	for (const line of lines) {
		if (!isDataField(line)) {
			rewritten.push(line);
			continue;
		}
		if (!inserted) {
			rewritten.push(`data: ${data}`);
			inserted = true;
		}
	}
	if (!inserted) rewritten.push(`data: ${data}`);
	return `${rewritten.join(lineEnding)}${lineEnding}${lineEnding}`;
}

/** Ensure an EOF-dispatched event is separated from any gateway event appended after it. */
export function terminateSseEvent(event: string): string {
	const lineEnding = preferredLineEnding(event);
	const lines = event.split(/\r\n|\r|\n/);
	while (lines.at(-1) === '') lines.pop();
	return `${lines.join(lineEnding)}${lineEnding}${lineEnding}`;
}

function lineEndingLengthAt(value: string, index: number): number {
	if (value[index] === '\n') return 1;
	if (value[index] !== '\r') return 0;
	// A CR at the end of the current read may be the first half of CRLF. Keep
	// it pending until the next read (or EOF) instead of minting a false blank line.
	if (index + 1 >= value.length) return -1;
	return value[index + 1] === '\n' ? 2 : 1;
}

function findEventBoundaryEnd(value: string, start: number): number | null {
	let index = start;
	while (index < value.length) {
		const firstLength = lineEndingLengthAt(value, index);
		if (firstLength < 0) return null;
		if (firstLength === 0) {
			index += 1;
			continue;
		}
		const secondIndex = index + firstLength;
		const secondLength = lineEndingLengthAt(value, secondIndex);
		if (secondLength < 0) return null;
		if (secondLength > 0) return secondIndex + secondLength;
		index = secondIndex;
	}
	return null;
}

/**
 * Incrementally frame SSE events with a strict bound on the only state retained
 * between upstream reads. Each complete event is handed to the caller before
 * more source bytes are requested, preserving downstream backpressure.
 */
export class BoundedSseEventFramer {
	private buffer = '';

	constructor(
		private readonly maxEventChars: number,
		private readonly limitErrorMessage: string,
	) {}

	async push(
		chunk: string,
		handleEvent: (event: string) => boolean | Promise<boolean>,
	): Promise<boolean> {
		this.buffer += chunk;
		let consumed = 0;
		while (true) {
			const boundaryEnd = findEventBoundaryEnd(this.buffer, consumed);
			if (boundaryEnd === null) break;
			if (boundaryEnd - consumed > this.maxEventChars) {
				this.buffer = '';
				throw new Error(this.limitErrorMessage);
			}
			const event = this.buffer.slice(consumed, boundaryEnd);
			consumed = boundaryEnd;
			if (await handleEvent(event)) {
				this.buffer = '';
				return true;
			}
		}

		if (consumed > 0) this.buffer = this.buffer.slice(consumed);
		if (this.buffer.length > this.maxEventChars) {
			this.buffer = '';
			throw new Error(this.limitErrorMessage);
		}
		return false;
	}

	finish(): string {
		if (this.buffer.length > this.maxEventChars) {
			this.buffer = '';
			throw new Error(this.limitErrorMessage);
		}
		const remainder = this.buffer;
		this.buffer = '';
		return remainder;
	}
}
