---
title: API keys
description: Choose, limit and rotate the right key.
---

## Key types

| Type | Purpose |
| --- | --- |
| Gateway API key | Call CinaToken inference APIs from an application |
| Provider key | Connect to an upstream model service; managed through provider or personal-key features |
| Management API key | Call authorized management APIs; not a substitute for an inference key |
| Browser session | Access account and admin pages; do not copy it into applications |

## Create and limit a key

Open your [account](/account), verify the workspace and create a Gateway API key. Use a separate key for each application and environment, with an appropriate spend limit and expiry.

A limit of `0` blocks billable usage. Leaving the limit blank adds no key-level cap, but account and workspace limits still apply. Recurring limits reset at the UTC boundaries shown in the interface.

The full key is displayed only when created. If the result is uncertain, refresh the list before attempting another creation.

## Rotate and revoke

Create a replacement key, update your application and confirm it works before revoking the old key. If a key leaks, revoke it immediately, check [activity](/account/activity) and inspect applications and logs that used it.

Keep Gateway API keys out of public website source. Do not use administrator keys to test public chat.
