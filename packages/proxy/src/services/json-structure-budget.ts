import type { RequestBodyInspector } from './bounded-request-body';

export interface JsonStructureLimits {
	readonly maxDepth: number;
	/** Containers, scalar values AND property names; duplicate properties still count. */
	readonly maxNodes: number;
	/** Optional decoded UTF-16 units per property name, including overwritten names. */
	readonly maxPropertyNameChars?: number;
}

/** Images JSON admission, independent of the existing request/response byte ceilings. */
export const IMAGE_JSON_STRUCTURE_LIMITS: Readonly<JsonStructureLimits> = Object.freeze({
	maxDepth: 64,
	maxNodes: 65_536,
});

export const IMAGE_JSON_MAX_PROPERTY_NAME_CHARS = 256;
/** Public Images JSON ingress and upstream JSON/SSE event admission only. */
export const IMAGE_JSON_ADMISSION_LIMITS: Readonly<JsonStructureLimits> = Object.freeze({
	...IMAGE_JSON_STRUCTURE_LIMITS,
	maxPropertyNameChars: IMAGE_JSON_MAX_PROPERTY_NAME_CHARS,
});

export class JsonStructureLimitError extends Error {
	constructor(readonly dimension: 'depth' | 'nodes' | 'property name characters', readonly limit: number) {
		super(`JSON structure exceeds the maximum ${dimension} of ${limit}`);
		this.name = 'JsonStructureLimitError';
	}
}

/**
 * Constant-state lexical admission BEFORE JSON.parse constructs an object graph.
 * For valid JSON, counts every container, primitive and property-name token.
 * Strings/escapes survive chunk splits; content is never retained or parsed here.
 *
 * This is deliberately not a JSON validator. Native JSON.parse remains the syntax
 * and value authority (including duplicate keys, number and Unicode semantics).
 * Invalid JSON may hit the resource ceiling first, but never becomes valid here.
 * Pair with a byte ceiling: bounded nodes/depth alone do not bound string storage,
 * runtime allocation overhead, concurrent requests, or encoded output copies.
 */
export class JsonStructureBudget {
	private readonly maxDepth: number;
	private readonly maxNodes: number;
	private readonly maxPropertyNameChars: number | undefined;
	private readonly scopes: Array<{ object: boolean; keyExpected: boolean }> = [];
	private stringIsKey = false;
	private keyChars = 0;
	private unicodeRemaining = 0;
	private depth = 0;
	private nodes = 0;
	private inString = false;
	private escaped = false;
	private inScalar = false;
	private failure: JsonStructureLimitError | undefined;

	constructor(limits: JsonStructureLimits) {
		if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1
			|| !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1
			|| (limits.maxPropertyNameChars !== undefined && (!Number.isSafeInteger(limits.maxPropertyNameChars) || limits.maxPropertyNameChars < 1))) {
			throw new RangeError('Invalid JSON structure limits');
		}
		this.maxDepth = limits.maxDepth;
		this.maxNodes = limits.maxNodes;
		this.maxPropertyNameChars = limits.maxPropertyNameChars;
	}

	get nodeCount(): number { return this.nodes; }
	get containerDepth(): number { return this.depth; }

	private addNode(): void {
		if (++this.nodes > this.maxNodes) this.fail('nodes', this.maxNodes);
	}

	private addKeyChar(): void {
		if (this.stringIsKey && ++this.keyChars > this.maxPropertyNameChars!) {
			this.fail('property name characters', this.maxPropertyNameChars!);
		}
	}

	private fail(dimension: JsonStructureLimitError['dimension'], limit: number): never {
		this.failure = new JsonStructureLimitError(dimension, limit);
		throw this.failure;
	}

	write(text: string): void {
		if (this.failure) throw this.failure;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (this.inString) {
				if (this.unicodeRemaining) this.unicodeRemaining--;
				else if (this.escaped) {
					this.escaped = false;
					if (code === 117) this.unicodeRemaining = 4; // One UTF-16 unit per \u escape.
					this.addKeyChar();
				}
				else if (code === 92) this.escaped = true; // backslash
				else if (code === 34) this.inString = false;
				else this.addKeyChar();
				continue;
			}
			if (code === 34) {
				this.addNode();
				this.inString = true;
				this.inScalar = false;
				this.stringIsKey = this.scopes.at(-1)?.keyExpected === true;
				this.keyChars = 0;
				this.unicodeRemaining = 0;
			} else if (code === 123 || code === 91) { // { [
				this.addNode();
				if (++this.depth > this.maxDepth) this.fail('depth', this.maxDepth);
				if (this.maxPropertyNameChars !== undefined) this.scopes.push({ object: code === 123, keyExpected: code === 123 });
				this.inScalar = false;
			} else if (code === 125 || code === 93) { // } ]
				// A negative depth is malformed syntax, not an allowance for later
				// nesting. Leave syntax rejection to the existing native parser.
				this.depth = Math.max(0, this.depth - 1);
				this.scopes.pop();
				this.inScalar = false;
			} else if (code === 44 || code === 58 || code === 32 || code === 9 || code === 10 || code === 13) {
				const scope = this.scopes.at(-1);
				if (scope && (code === 44 || code === 58)) scope.keyExpected = code === 44 && scope.object;
				this.inScalar = false; // comma, colon, JSON whitespace
			} else if (!this.inScalar) {
				this.addNode();
				this.inScalar = true;
			}
		}
	}
}

/** Inspect decoded JSON before a native request consumer receives its byte chunks. */
export function createJsonStructureBodyInspector(limits: JsonStructureLimits): RequestBodyInspector {
	const budget = new JsonStructureBudget(limits);
	let decoder: TextDecoder | undefined = new TextDecoder();
	return {
		write(chunk) {
			if (!decoder) throw new Error('JSON body inspector is closed');
			// A transport may supply one huge chunk; the inspector never makes a
			// second whole-body text representation alongside the native consumer.
			for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
				budget.write(decoder.decode(chunk.subarray(offset, offset + 64 * 1024), { stream: true }));
			}
		},
		end() {
			if (!decoder) throw new Error('JSON body inspector is closed');
			budget.write(decoder.decode());
			decoder = undefined;
		},
		dispose() { decoder = undefined; },
	};
}
