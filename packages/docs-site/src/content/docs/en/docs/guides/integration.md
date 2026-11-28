---
title: System integration
description: Business systems integrate accounts, workspaces and inference through their backend, with separate management and inference authorization.
---

Business systems integrate accounts, workspaces and inference through their backend, with separate management and inference authorization.

## Workflow

1. Define user, workspace and application ownership without reusing keys across scopes.
2. Keep management credentials on the backend and issue constrained inference keys to callers.
3. Validate errors, principal identities and retry outcomes, preserving request or audit IDs.

## What to verify

Business metadata belongs to the integrating system; do not depend on implicit reinterpretation by the proxy.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/integration.md)
