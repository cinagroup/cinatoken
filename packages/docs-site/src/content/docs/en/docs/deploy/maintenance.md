---
title: Maintenance windows
description: Maintenance mode controls inference and management writes during a planned window; read-only exceptions follow the engineering contract.
---

Maintenance mode controls inference and management writes during a planned window; read-only exceptions follow the engineering contract.

## Workflow

1. Confirm the scope, owner, current version and database backup.
2. Enter the window using the maintenance guide and verify rejection of inference and management writes.
3. Restore service after changes and readiness checks, then verify key endpoints.

## What to verify

A maintenance rejection does not mean a user has a zero balance.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/maintenance-mode.md)
