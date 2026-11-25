/** Keep legacy Admin description clients compatible with the operator note field. */
export function catalogNotePatch(input: Record<string, unknown>): Record<string, unknown> {
 const hasNote = input.note !== undefined;
 const hasDescription = input.description !== undefined;
 if (!hasNote && !hasDescription) return input;
 if (hasNote && hasDescription && input.note !== input.description) throw new Error('Conflicting catalog note fields');
 const value = hasNote ? input.note : input.description;
 if (value !== null && typeof value !== 'string') throw new Error('Catalog note must be string or null');
 return {...input, note: value, description: value};
}

/** The legacy column remains authoritative while old and new Admin writers overlap. */
export function catalogNoteValue(row:{description?:string|null;note?:string|null}):string|null {
 return row.description !== undefined ? row.description : row.note ?? null;
}
