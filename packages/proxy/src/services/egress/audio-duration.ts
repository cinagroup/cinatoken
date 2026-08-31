/**
 * 音频计费时长解析：优先上游 → 容器解析 → 客户端上报 → 字节估算。
 * 不依赖原生编解码；WAV / WebM Duration 为确定性解析。
 */
import { estimateAudioDurationFromBytes } from './openai-audio-driver';

export type AudioDurationSource = 'upstream' | 'media' | 'client' | 'estimated';

export type ResolvedAudioDuration = {
	seconds: number;
	source: AudioDurationSource;
};

export const MAX_AUDIO_DURATION_SECONDS = 25 * 60;

function isFinitePositive(n: number): boolean {
	return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function clampBillingSeconds(seconds: number): number {
	if (!isFinitePositive(seconds)) {
		return 1;
	}
	return Math.min(MAX_AUDIO_DURATION_SECONDS, Math.max(0.2, seconds));
}

/** RIFF/WAVE：byteRate + data chunk size → 秒 */
export function parseWavDurationSeconds(bytes: Uint8Array): number | null {
	if (bytes.byteLength < 44) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, false) !== 0x52494646) return null; // RIFF
	if (view.getUint32(8, false) !== 0x57415645) return null; // WAVE

	let offset = 12;
	let byteRate = 0;
	let dataSize = 0;
	while (offset + 8 <= bytes.byteLength) {
		const chunkId = view.getUint32(offset, false);
		const chunkSize = view.getUint32(offset + 4, true);
		const dataOffset = offset + 8;
		if (chunkId === 0x666d7420 /* fmt */) {
			if (dataOffset + 16 > bytes.byteLength) return null;
			byteRate = view.getUint32(dataOffset + 8, true);
		} else if (chunkId === 0x64617461 /* data */) {
			dataSize = chunkSize;
			break;
		}
		offset = dataOffset + chunkSize + (chunkSize % 2);
	}
	if (byteRate <= 0 || dataSize <= 0) return null;
	const seconds = dataSize / byteRate;
	return isFinitePositive(seconds) ? seconds : null;
}

/**
 * 最小 EBML VINT 读取（WebM/Matroska）。
 * @returns [value, bytesConsumed] or null
 */
function readEbmlVint(
	bytes: Uint8Array,
	offset: number,
	asLength: boolean
): { value: number; size: number } | null {
	if (offset >= bytes.byteLength) return null;
	const first = bytes[offset]!;
	if (first === 0) return null;
	let mask = 0x80;
	let size = 1;
	while (size <= 8 && (first & mask) === 0) {
		mask >>= 1;
		size++;
	}
	if (size > 8 || offset + size > bytes.byteLength) return null;
	let value = asLength ? first & (mask - 1) : first;
	for (let i = 1; i < size; i++) {
		value = value * 256 + bytes[offset + i]!;
	}
	// 全 1 表示 unknown length
	if (asLength) {
		const unknown = (1 << (7 * size)) - 1;
		if (value === unknown) {
			return { value: -1, size };
		}
	}
	return { value, size };
}

function readEbmlFloat(bytes: Uint8Array, offset: number, size: number): number | null {
	if (size !== 4 && size !== 8) return null;
	if (offset + size > bytes.byteLength) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
	return size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

/**
 * WebM：读取 Segment Info 中的 Duration（单位：TimecodeScale，默认 1_000_000 ns）。
 * MediaRecorder 产出的 webm 通常带 Duration。
 */
export function parseWebmDurationSeconds(bytes: Uint8Array): number | null {
	if (bytes.byteLength < 16) return null;
	// EBML header id 1A45DFA3
	if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
		return null;
	}

	let timecodeScale = 1_000_000; // ns
	let durationTicks: number | null = null;
	const end = Math.min(bytes.byteLength, 512 * 1024); // Info 一般在文件前部
	let offset = 0;

	while (offset + 3 < end) {
		const idStart = offset;
		const id = readEbmlVint(bytes, offset, false);
		if (!id) break;
		offset += id.size;
		const len = readEbmlVint(bytes, offset, true);
		if (!len) break;
		offset += len.size;
		const payloadStart = offset;
		const payloadLen = len.value;
		const payloadEnd =
			payloadLen < 0 ? end : Math.min(end, payloadStart + payloadLen);

		// Duration = 0x4489
		if (id.size === 2 && bytes[idStart] === 0x44 && bytes[idStart + 1] === 0x89) {
			const f = readEbmlFloat(bytes, payloadStart, payloadEnd - payloadStart);
			if (f != null && Number.isFinite(f) && f > 0) {
				durationTicks = f;
			}
		}
		// TimecodeScale = 0x2AD7B1
		if (
			id.size === 3 &&
			bytes[idStart] === 0x2a &&
			bytes[idStart + 1] === 0xd7 &&
			bytes[idStart + 2] === 0xb1
		) {
			let scale = 0;
			for (let i = payloadStart; i < payloadEnd; i++) {
				scale = scale * 256 + bytes[i]!;
			}
			if (scale > 0) {
				timecodeScale = scale;
			}
		}

		if (payloadLen < 0) {
			// unknown-size container：继续线性扫描子元素
			offset = payloadStart;
			continue;
		}
		// 对 Info(0x1549A966) / Segment(0x18538067) 进入内部扫描：不跳过
		const isInfo =
			id.size === 4 &&
			bytes[idStart] === 0x15 &&
			bytes[idStart + 1] === 0x49 &&
			bytes[idStart + 2] === 0xa9 &&
			bytes[idStart + 3] === 0x66;
		const isSegment =
			id.size === 4 &&
			bytes[idStart] === 0x18 &&
			bytes[idStart + 1] === 0x53 &&
			bytes[idStart + 2] === 0x80 &&
			bytes[idStart + 3] === 0x67;
		if (isInfo || isSegment) {
			// 进入容器内部继续扫 TimecodeScale / Duration（二者顺序不定）
			offset = payloadStart;
			continue;
		}
		offset = payloadEnd;
	}

	if (durationTicks == null || timecodeScale <= 0) {
		return null;
	}
	const seconds = (durationTicks * timecodeScale) / 1e9;
	return isFinitePositive(seconds) ? seconds : null;
}

export function parseAudioFileDurationSeconds(
	bytes: Uint8Array,
	mimeType: string
): number | null {
	const mime = (mimeType || '').trim().toLowerCase().split(';')[0] || '';
	const wav = parseWavDurationSeconds(bytes);
	if (wav != null) return wav;
	if (mime.includes('webm') || mime.includes('matroska') || mime === 'application/octet-stream') {
		const webm = parseWebmDurationSeconds(bytes);
		if (webm != null) return webm;
	}
	// 无扩展名时再尝试 webm 魔数
	if (!mime.includes('wav') && !mime.includes('wave')) {
		const webm = parseWebmDurationSeconds(bytes);
		if (webm != null) return webm;
	}
	return null;
}

/**
 * 客户端上报时长校验：防极端作弊，同时接纳 MediaRecorder 墙钟时长。
 * 允许相对字节估算有较大偏差（webm 码率远高于 16kbps）。
 */
export function acceptClientDurationSeconds(
	clientSeconds: number,
	fileBytes: number
): number | null {
	if (!isFinitePositive(clientSeconds)) return null;
	if (clientSeconds < 0.2 || clientSeconds > MAX_AUDIO_DURATION_SECONDS) return null;
	if (!Number.isFinite(fileBytes) || fileBytes <= 0) return null;
	const bytesPerSec = fileBytes / clientSeconds;
	// 拒绝明显不可能的码率（> 2 Mbps 或 < 200 bps）
	if (bytesPerSec > 250_000 || bytesPerSec < 25) return null;
	return clientSeconds;
}

export function resolveAudioBillingDuration(input: {
	upstreamSeconds: number | null | undefined;
	fileBytes: number;
	mimeType: string;
	fileBytesForParse?: Uint8Array;
	clientSeconds?: number | null;
}): ResolvedAudioDuration {
	if (input.upstreamSeconds != null && isFinitePositive(input.upstreamSeconds)) {
		return { seconds: clampBillingSeconds(input.upstreamSeconds), source: 'upstream' };
	}

	const mediaBytes = input.fileBytesForParse;
	if (mediaBytes && mediaBytes.byteLength > 0) {
		const media = parseAudioFileDurationSeconds(mediaBytes, input.mimeType);
		if (media != null) {
			return { seconds: clampBillingSeconds(media), source: 'media' };
		}
	}

	if (input.clientSeconds != null) {
		const accepted = acceptClientDurationSeconds(input.clientSeconds, input.fileBytes);
		if (accepted != null) {
			return { seconds: clampBillingSeconds(accepted), source: 'client' };
		}
	}

	return {
		seconds: clampBillingSeconds(estimateAudioDurationFromBytes(input.fileBytes)),
		source: 'estimated',
	};
}
