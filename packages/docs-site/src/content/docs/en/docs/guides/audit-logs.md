---
title: Management audit logs
description: Audit Logs identify management actors and affected resources; they serve a different purpose from inference logs.
---

Audit Logs identify management actors and affected resources; they serve a different purpose from inference logs.

## Workflow

1. Find management actions by time and affected resource.
2. Check the actor, target and result, then correlate a request or business receipt.
3. When a write outcome is uncertain, refresh the resource and audit records before retrying.

## What to verify

A success message does not replace verification of the server receipt and saved state.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/admin.md)
