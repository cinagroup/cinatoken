---
title: Upgrades and rollback
description: Upgrade using a specific version, its migration requirements and a frozen artifact, with a verifiable rollback path.
---

Upgrade using a specific version, its migration requirements and a frozen artifact, with a verifiable rollback path.

## Workflow

1. Read the target changes and migrations, recording the current version and configuration.
2. Validate in an isolated environment and follow the prescribed migration and application order.
3. Check key workflows and older assets after activation; use the relevant rollback procedure if needed.

## What to verify

Rolling back a Web entry does not undo database changes, financial records or external actions.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/maintainers/release-versioning.md)
