---
title: Public model catalog loading fixed
description: Public catalog response validation and database query compatibility were corrected while preserving the boundary around internal notes.
sidebar:
  hidden: true
---

2026-11-28 UTC · CinaToken

Public catalog descriptions may be null; internal operational notes remain behind management access. Model lists and chat selection consume validated public responses, and failed responses are not presented as successful empty catalogs.

Endpoint lists and details normalize database timestamps, verification states and expiry. Administrators still review routes, protocol capabilities and endpoint verification before publishing a model.

[Live models](/en/models) · [Choosing models](/en/docs/models/)

[Source commit](https://github.com/cinagroup/cinatoken/commit/8119804c3c91a73080d14637586f6375f0aadf99)
