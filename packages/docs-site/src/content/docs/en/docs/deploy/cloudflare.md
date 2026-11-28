---
title: Cloudflare deployment
description: Cloudflare deployment requires verification of service bindings, storage and routes, alongside static pages.
---

Cloudflare deployment requires verification of service bindings, storage and routes, alongside static pages.

## Workflow

1. Generate configuration for the correct account and distinguish local from remote databases.
2. Run the required migrations and build checks before uploading a candidate version.
3. Verify bindings, variables, domains and callbacks, then check authentication, catalog and asset delivery after activation.

## What to verify

The same-domain Web entry forwards business requests and should not acquire database or master-key access.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/deployment/cloudflare.md)
