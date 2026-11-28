---
title: Clients and SDKs
description: Compatible clients generally need a base URL, Gateway API key and callable model ID.
---

Compatible clients generally need a base URL, Gateway API key and callable model ID.

## Workflow

1. Create an inference key in the intended workspace.
2. Use https://api.cinatoken.com/v1 where a client expects a versioned base URL; omit /v1 when the client appends it.
3. Copy a live model ID and test short text before enabling other capabilities.

## What to verify

A client sign-in session is not a substitute for a Gateway API key.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/connect-clients.md)
