---
title: Provider budgets and capacity
description: An upstream provider’s balance, rate limits and capacity are separate from a CinaToken user’s budget.
---

An upstream provider’s balance, rate limits and capacity are separate from a CinaToken user’s budget.

## Workflow

1. Check the provider account, region, upstream allowance and enabled state.
2. Inspect rate-limit, budget and upstream failure logs instead of only raising the user budget.
3. Adjust traffic through verified alternative routes and retest the preferred and fallback targets.

## What to verify

Retries do not create upstream capacity; requests can still fail without an available fallback.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/configuration.md)
