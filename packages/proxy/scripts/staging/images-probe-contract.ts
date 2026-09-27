/** Non-secret, staging-only handshake. The runner must arm the exact row before dispatch. */
export type ProbeMode = 'headers' | 'body' | 'release';
export type ImageProbe = { runId: string; probeId: string; mode: ProbeMode };
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pattern = new RegExp(`^c02-probe:(c02-success-${uuid}):(${uuid}):(headers|body|release)$`);
export function parseImageProbe(prompt: unknown): ImageProbe | null {
  if (typeof prompt !== 'string' || prompt.length > 180) return null;
  const match = pattern.exec(prompt);
  return match ? { runId: match[1], probeId: match[2], mode: match[3] as ProbeMode } : null;
}
export function imageProbePrompt(probe: ImageProbe): string {
  const prompt = `c02-probe:${probe.runId}:${probe.probeId}:${probe.mode}`;
  if (!parseImageProbe(prompt)) throw new Error('Invalid synthetic probe identity');
  return prompt;
}
export function imageProbeRow(probe: ImageProbe) {
  imageProbePrompt(probe);
  return { key: `c02_images_probe:${probe.probeId}`, description: `c02-lifecycle:${probe.runId}`,
    value: JSON.stringify({ ...probe, phase: 'armed' }) };
}
