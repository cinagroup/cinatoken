export type ImageStorageFaultMode = 'before-release' | 'after-release' | 'before-fail' | 'after-fail' | 'before-abort' | 'after-abort' | 'before-fence';
export type ImageStorageFault = { runId: string; probeId: string; mode: ImageStorageFaultMode };
export const IMAGE_STORAGE_FAULT_HEADER = 'x-c02-d1-fault';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pattern = new RegExp(`^c02-storage:(c02-success-${UUID}):(${UUID}):(before-release|after-release|before-fail|after-fail|before-abort|after-abort|before-fence)$`);
export function parseImageStorageFault(value: unknown): ImageStorageFault | null {
	if (typeof value !== 'string' || value.length > 190) return null;
	const match = pattern.exec(value);
	if (!match) return null;
	const mode = match[3];
	if (mode !== 'before-release' && mode !== 'after-release' && mode !== 'before-fail' && mode !== 'after-fail'
		&& mode !== 'before-abort' && mode !== 'after-abort' && mode !== 'before-fence') return null;
	return { runId: match[1], probeId: match[2], mode };
}
export function imageStorageFaultHeader(probe: ImageStorageFault): string {
	const value = `c02-storage:${probe.runId}:${probe.probeId}:${probe.mode}`;
	if (!parseImageStorageFault(value)) throw new Error('Invalid bounded storage fault');
	return value;
}
export function imageStorageFaultRow(probe: ImageStorageFault) {
	imageStorageFaultHeader(probe);
	return { key: 'c02_images_storage:' + probe.probeId, description: 'c02-storage:' + probe.runId,
		value: JSON.stringify({ ...probe, phase: 'armed' }) };
}
