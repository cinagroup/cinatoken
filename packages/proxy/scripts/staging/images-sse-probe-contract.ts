export const IMAGE_SSE_PATH = '/sse/v1/images/generations';
export const IMAGE_SSE_MODES = ['success', 'provider-error', 'partial-provider-error', 'invalid-json',
  'early-eof', 'usage-limit', 'property-limit', 'hold'] as const;
export type ImageSseMode = typeof IMAGE_SSE_MODES[number];
export type ImageSseProbe = { runId: string; probeId: string; mode: ImageSseMode };
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pattern = new RegExp(`^c02-sse:(c02-success-${uuid}):(${uuid}):(${IMAGE_SSE_MODES.join('|')})$`);
export function parseImageSseProbe(value: unknown): ImageSseProbe | null {
  if (typeof value !== 'string' || value.length > 180) return null;
  const match = pattern.exec(value);
  return match ? { runId: match[1], probeId: match[2], mode: match[3] as ImageSseMode } : null;
}
export function imageSsePrompt(probe: ImageSseProbe): string {
  const prompt = `c02-sse:${probe.runId}:${probe.probeId}:${probe.mode}`;
  if (!parseImageSseProbe(prompt)) throw new Error('Invalid SSE probe identity');
  return prompt;
}
export function imageSseRow(probe: ImageSseProbe) {
  imageSsePrompt(probe);
  return { key: `c02_images_sse_probe:${probe.probeId}`, description: `c02-sse:${probe.runId}`,
    value: JSON.stringify({ ...probe, phase: 'armed' }) };
}
