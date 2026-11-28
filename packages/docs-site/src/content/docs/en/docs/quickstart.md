---
title: Quickstart
description: Make your first model request.
---

## 1. Sign in and choose a workspace

Open your [account](/account) and sign in with CinaAuth. Check the selected workspace: keys and data are scoped to it.

## 2. Create a Gateway API key

In the Gateway API keys section, choose **Create key**. Set an application name, spend limit and expiry as needed. The full key is shown only at creation; save it in your server-side secret manager.

A spend limit of `0` blocks billable calls. Account and workspace limits, along with model availability, still apply.

## 3. Choose a live model

Copy a callable model ID from the [model catalog](/en/models). Do not assume a reference template name is available.

## 4. Send a request

Set `CINATOKEN_API_KEY` and `CINATOKEN_MODEL` locally. Keep keys out of public repositories, screenshots and frontend code.

```bash
export CINATOKEN_MODEL='a callable ID from the catalog'
# Supply CINATOKEN_API_KEY through your environment or secret manager.
curl https://api.cinatoken.com/v1/chat/completions \
  -H "Authorization: Bearer $CINATOKEN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$CINATOKEN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

The response should contain the model's reply. If it fails, record the HTTP status and request ID and follow [troubleshooting](/en/docs/troubleshooting/).

Next: [API access](/en/docs/api/) · [Key management](/en/docs/keys/)
