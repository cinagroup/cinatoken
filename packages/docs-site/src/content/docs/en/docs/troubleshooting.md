---
title: Troubleshooting
description: Find the next step from the sign-in or request error.
---

## Sign-in

For “sign-in did not finish,” follow [sign-in help](/en/docs/authentication/) and authenticate once again. Administrator verification differs from ordinary account access; start at `/admin` when you need the console.

## API errors

| Symptom | Check first |
| --- | --- |
| `401` | Gateway API key type, revocation, expiry and authorization header |
| `403` | Key, account and workspace permissions for the resource and action |
| `404` or unavailable model | Service URL, callable model ID and current catalog |
| Budget or billing rejection | A key cap of `0`, workspace budgets and account restrictions |
| `429` | Rate limits or upstream capacity; follow retry guidance and back off |
| `5xx`, timeout or disconnected stream | Save the request ID and retry a bounded number of times later; avoid duplicate long requests |

Do not bypass errors by disabling authentication, exposing administrator keys or retrying indefinitely.

## Data could not be verified

“Dashboard data could not be verified” means the page did not receive a valid response matching its contract. Refresh once. If it persists, record the time, page path and error. This state is not a zero-usage result.

## What to share with an administrator

Provide the time and timezone, page or API path, model ID, HTTP status, request ID and sanitized error text. Do not share full keys, cookies, authentication callback parameters or sensitive input.
