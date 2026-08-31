import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureOpenAiStreamIncludesUsage } from './openai-stream-usage-request';

test('OpenAI Chat streaming forces include_usage while preserving other stream options', () => {
	assert.deepEqual(
		ensureOpenAiStreamIncludesUsage({
			stream: true,
			stream_options: { include_usage: false, exclude_aggregated_audio: true },
		}),
		{
			stream: true,
			stream_options: { include_usage: true, exclude_aggregated_audio: true },
		},
	);
});

test('non-streaming OpenAI Chat body is unchanged and protocol-specific bodies are not touched', () => {
	const body = { stream: false, stream_options: { include_usage: false } };
	assert.equal(ensureOpenAiStreamIncludesUsage(body), body);
});
