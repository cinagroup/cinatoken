---
title: Agent tools
description: Tools expose configured search, fetch and related services through the gateway. Administrators configure their engines.
---

Tools expose configured search, fetch and related services through the gateway. Administrators configure their engines.

## Workflow

1. Check enabled state, engine selection and authentication in tool configuration.
2. Confirm caller permissions and follow the contract for the relevant /v1/tools/* operation.
3. Verify configuration, then inspect results, usage and logs through a real proxy request.

## What to verify

Management engine tests and production gateway calls have different execution and billing boundaries.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/features.md)
