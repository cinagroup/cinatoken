---
title: Administrator guide
description: Understand the console and model publication flow.
---

## Open the console

Open the [admin console](/admin) and complete CinaAuth administrator verification. The server checks the actual role; showing a frontend link does not grant access.

Account pages manage your own workspace and keys. The console configures platform resources and provides permission-controlled global records. Its overview is `/admin`; old `/dashboard` bookmarks redirect there.

## Publish a model

1. Configure a provider and its authentication in **Providers**.
2. Review callable IDs, capabilities and billing configuration in **Models**.
3. Configure and verify matching protocol entries in **Endpoints**.
4. Connect models to available providers in **Routes** and check enabled states.
5. Complete public-publication checks, then verify the public catalog and an actual request.

Importing a catalog template is not a completed deployment. Endpoint verification can expire; check its current state. Keep internal notes, provider keys and management endpoint configuration out of public descriptions.

## Review changes

Record the affected resource and intended result, then validate on a small scope. Check routes, currencies, prices, time windows, permissions and audit records. Understand existing callers before deletion, disabling or billing changes.

See the [repository documentation](https://github.com/cinagroup/cinatoken/blob/main/docs/README.md) for engineering and operations. This guide does not replace deployment procedures or production migration checks.
