---
title: Image generation and editing
description: Image requests need an available image model and matching endpoint; a text-model ID is not a substitute.
---

Image requests need an available image model and matching endpoint; a text-model ID is not a substitute.

## Workflow

1. Verify image models, generation or editing capability and input requirements in the live catalog.
2. Use /v1/images/generations or /v1/images/edits as supported by the model.
3. Check size, count, response format and whether usage is measured per image or token.

## What to verify

An image template in the reference catalog does not establish an available hosted route.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/reference/image-models.md)
