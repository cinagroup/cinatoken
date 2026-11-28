---
title: MCP access
description: The MCP entry aggregates configured remote services and tools. Availability depends on configuration, catalog state and caller permissions.
---

The MCP entry aggregates configured remote services and tools. Availability depends on configuration, catalog state and caller permissions.

## Workflow

1. Have an administrator configure services, synchronize their tool catalog and review changes.
2. Use the supplied MCP URL and authenticate using the server’s advertised flow.
3. Discover available tools before a controlled call and review its audit record.

## What to verify

Account sessions, inference keys and MCP OAuth authorization are not interchangeable.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/user.md)
