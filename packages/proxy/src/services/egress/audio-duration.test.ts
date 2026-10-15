import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptClientDurationSeconds, parseWavDurationSeconds, resolveAudioBillingDuration } from './audio-duration';

function buildSilentWav(durationSeconds: number, sampleRate = 8000): Uint8Array {
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const dataSize = Math.round(durationSeconds * byteRate);
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeStr(8, 'WAVE');
	writeStr(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, numChannels * (bitsPerSample / 8), true);
	view.setUint16(34, bitsPerSample, true);
	writeStr(36, 'data');
	view.setUint32(40, dataSize, true);
	return new Uint8Array(buffer);
}

describe('parseWavDurationSeconds', () => {
	it('reads duration from WAV header', () => {
		const wav = buildSilentWav(2.5);
		const seconds = parseWavDurationSeconds(wav);
		assert.ok(seconds != null);
		assert.ok(Math.abs(seconds! - 2.5) < 0.05);
	});
});

describe('acceptClientDurationSeconds', () => {
	it('accepts MediaRecorder-like short clip', () => {
		assert.equal(acceptClientDurationSeconds(2.1, 42_800), 2.1);
	});

	it('rejects absurdly short duration for large file', () => {
		assert.equal(acceptClientDurationSeconds(0.01, 42_800), null);
	});
});

describe('resolveAudioBillingDuration', () => {
	it('prefers upstream over media/client/estimate', () => {
		const wav = buildSilentWav(3);
		const resolved = resolveAudioBillingDuration({
			upstreamSeconds: 1.5,
			fileBytes: wav.byteLength,
			mimeType: 'audio/wav',
			fileBytesForParse: wav,
			clientSeconds: 9,
		});
		assert.equal(resolved.source, 'upstream');
		assert.equal(resolved.seconds, 1.5);
	});

	it('uses WAV media duration when upstream missing', () => {
		const wav = buildSilentWav(2);
		const resolved = resolveAudioBillingDuration({
			upstreamSeconds: null,
			fileBytes: wav.byteLength,
			mimeType: 'audio/wav',
			fileBytesForParse: wav,
			clientSeconds: 9,
		});
		assert.equal(resolved.source, 'media');
		assert.ok(Math.abs(resolved.seconds - 2) < 0.05);
	});

	it('uses client duration when media parse unavailable', () => {
		const resolved = resolveAudioBillingDuration({
			upstreamSeconds: null,
			fileBytes: 42_800,
			mimeType: 'audio/webm',
			fileBytesForParse: new Uint8Array([1, 2, 3, 4]),
			clientSeconds: 2.2,
		});
		assert.equal(resolved.source, 'client');
		assert.equal(resolved.seconds, 2.2);
	});

	it('falls back to byte estimate last', () => {
		const resolved = resolveAudioBillingDuration({
			upstreamSeconds: null,
			fileBytes: 42_800,
			mimeType: 'audio/webm',
			fileBytesForParse: new Uint8Array([1, 2, 3, 4]),
			clientSeconds: null,
		});
		assert.equal(resolved.source, 'estimated');
		assert.equal(resolved.seconds, 21.4);
	});
});
