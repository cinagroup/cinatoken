---
title: Embedding models
description: Embedding models return vectors for retrieval or similarity tasks rather than chat replies.
---

Embedding models return vectors for retrieval or similarity tasks rather than chat replies.

## Workflow

1. Verify an available embedding model and the required dimensions.
2. Use a compatible /v1/embeddings request or the model’s declared native entry.
3. Check batch size, input limits, vector dimensions and input usage.

## What to verify

Changing a model or dimensions may require rebuilding an existing vector index, not merely replacing the model ID.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/user.md)
