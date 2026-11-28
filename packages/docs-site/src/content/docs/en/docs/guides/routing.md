---
title: Model routing and failover
description: Routes connect request surfaces to upstream targets. Priority controls tiers; a strategy orders candidates within a tier.
---

Routes connect request surfaces to upstream targets. Priority controls tiers; a strategy orders candidates within a tier.

## Workflow

1. Choose a model and request surface, matching protocols and upstream model names.
2. Set priorities, weights and within-tier strategy, then verify provider and route enabled states.
3. Test the preferred target and permitted failover behavior, inspecting request logs.

## What to verify

Provider stickiness is a route-pool rule, not a fifth candidate-selection strategy.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/reference/route-strategies.md)
