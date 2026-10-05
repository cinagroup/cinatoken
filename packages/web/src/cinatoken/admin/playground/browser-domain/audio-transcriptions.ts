/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { isAudioModel, type ModelKindFields } from './model-modalities'

/** Align with Proxy audio driver limits (admin must not depend on `@octafuse/proxy`). */
export const AUDIO_MAX_BYTES_PER_FILE = 25 * 1024 * 1024

/** Default JSON fields for transcriptions (audio file uploaded separately as multipart). */
export const AUDIO_TRANSCRIPTIONS_BODY_TEMPLATE = `{
  "model": "<auto>",
  "language": "",
  "response_format": "json",
  "file_url": ""
}`

/** OpenAI 入口测异步 filetrans 时用公网 file_url，不再上传本地文件。 */
export const AUDIO_TRANSCRIPTIONS_FILE_URL_BODY_TEMPLATE = `{
  "model": "<auto>",
  "file_url": "https://example.com/sample.wav",
  "language": "zh",
  "response_format": "json"
}`

/** DashScope 同步 multimodal HTTP 透传模板（官方 input_audio）。 */
export const DASHSCOPE_MULTIMODAL_ASR_BODY_TEMPLATE = `{
  "model": "<auto>",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_audio",
            "input_audio": { "data": "https://example.com/sample.wav" }
          }
        ]
      }
    ]
  },
  "parameters": {
    "format": "wav",
    "language_hints": ["zh"]
  }
}`

/** 默认使用 OpenAI 与 DashScope Qwen TTS 都支持的 WAV，避免模板直接触发上游格式错误。 */
export const AUDIO_SPEECH_BODY_TEMPLATE = `{
  "model": "<auto>",
  "input": "你好，欢迎使用 cinatoken Gateway。",
  "voice": "alloy",
  "response_format": "wav",
  "speed": 1
}`

export function isAudioRouteModel(m: ModelKindFields): boolean {
	return isAudioModel(m)
}

/** Validate audio file before send (Playground / Simulator). */
export function validateAudioTranscriptionFile(
	file: File | null | undefined
): { ok: true } | { ok: false; error: string } {
	if (!file) {
		return { ok: false, error: 'An audio file is required' }
	}
	if (file.size > AUDIO_MAX_BYTES_PER_FILE) {
		return {
			ok: false,
			error: `audio file must be at most ${AUDIO_MAX_BYTES_PER_FILE} bytes`,
		}
	}
	return { ok: true }
}
