---
title: Users and administrator access
description: Gateway user records, CinaAuth identities and workspace permissions are related but distinct.
---

Gateway user records, CinaAuth identities and workspace permissions are related but distinct.

## Workflow

1. Review the principal, external mapping and state in Users.
2. Configure the intended workspace and limits, then verify access with a constrained key.
3. Administrator access follows CinaAuth roles and server revalidation; sign in through the admin entry after a role change.

## What to verify

Creating a gateway user does not automatically create a CinaAuth account or grant identity-administration access.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/integration.md)
