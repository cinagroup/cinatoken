---
title: Playground
description: Playground tests an individual upstream route or tool engine separately from a production proxy call.
---

Playground tests an individual upstream route or tool engine separately from a production proxy call.

## Workflow

1. Choose the specific route, protocol or tool engine to inspect.
2. Review the upstream URL, model name and effective parameters before sending a controlled sample.
3. After checking the upstream response, verify routing and billing through a production gateway request.

## What to verify

Playground bypasses gateway billing, request logging and failover; the upstream service may still charge.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/features.md)
