# Native asynchronous transcription

`POST /v1/dashscope/services/audio/asr/transcription` accepts 1–20 HTTP(S) audio URLs in `input.file_urls`. The gateway applies input Guardrails and route/data policies, then reserves ordinary, workspace, Gateway Key and configured Guardrail budgets before the selected provider dispatch.

An accepted asynchronous request has no authoritative final duration. It uses the existing unknown-cost settlement rule: conservatively consume the reserved ceiling, based on the server's maximum audio duration per submitted file. The POST waits for this accounting write before issuing a task receipt. This is a reserved-cost settlement, not a claim about the provider's final measured usage. Both POST and GET expose `X-CinaToken-Settlement-Basis: reserved`.

The POST response preserves the provider's JSON and adds `gateway_task_receipt`; the same token is returned in `X-CinaToken-Task-Receipt`. Save this receipt with `output.task_id`. To poll `GET /v1/dashscope/tasks/{taskId}?model={originalModel}`, send the receipt in `X-CinaToken-Task-Receipt`, or as the `receipt` query parameter. Treat the receipt as a private capability and prefer the header.

A receipt expires after 24 hours and binds the authenticated user, workspace and Gateway Key, model/route group, provider, exact route target/provider-key identity, task, original request ID and budget snapshot. A key or workspace change cannot use another owner's receipt. Polls re-evaluate current policies, require the original route and do not create another debit. They return the original request ID. Changing or removing the original provider route can make the task unavailable; the gateway will not send the task ID to an unrelated provider.

Receipts require the persistent `SHARED_KEY_ENCRYPTION_SECRET` already configured for provider credentials. HMAC signatures use a separate purpose string. Rotating that secret invalidates outstanding receipts.
