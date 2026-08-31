/** Parse one SSE `data` field. The single space after `:` is optional per SSE. */
export function parseSseDataLine(line: string): string | null {
	if (!line.startsWith('data:')) return null;
	const value = line.slice(5);
	return value.startsWith(' ') ? value.slice(1) : value;
}
