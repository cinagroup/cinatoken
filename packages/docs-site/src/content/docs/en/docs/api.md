---
title: API access
description: Connect to the OpenAI-compatible chat endpoint.
---

## Connection settings

| Setting | Value |
| --- | --- |
| Service origin | `https://api.cinatoken.com` |
| Base URL for OpenAI-compatible clients | `https://api.cinatoken.com/v1` |
| Chat request path | `/v1/chat/completions` |
| Authentication | `Authorization: Bearer <Gateway API key>` |
| Model ID | Copy from the [live catalog](/en/models) |

If your client appends `/v1` automatically, use the service origin without `/v1` to avoid `/v1/v1/...`.

## Request body

```json
{
  "model": "a callable ID from the catalog",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

See the [quickstart](/en/docs/quickstart/) for a complete command. Confirm a short text request works before adding images, tools or other parameters. Use a capability only when the catalog declares it and the endpoint supports it.

## Streaming

With `stream: true`, read the event stream incrementally. Handle disconnects, timeouts and cancellation in your application. Avoid unlimited retries, which can incur additional charges. Preserve the status code and request ID when a request fails.

## Management APIs and public information

Public model capabilities are different from administrator endpoint configuration. Management APIs have separate authentication and permission requirements. Never fix a public page's `401` by embedding a management key in it.
