---
title: Audio transcription and speech
description: Transcription, speech synthesis and realtime audio use their own models, protocols and usage units.
---

Transcription, speech synthesis and realtime audio use their own models, protocols and usage units.

## Workflow

1. Verify ASR, TTS or realtime capability and an available endpoint.
2. Use /v1/audio/transcriptions, /v1/audio/speech or a supported realtime entry as documented.
3. Check file type, language, voice, response format and duration, character or token units.

## What to verify

Uploading audio does not grant microphone access. Recording requires the user’s separate browser permission.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/user.md)
