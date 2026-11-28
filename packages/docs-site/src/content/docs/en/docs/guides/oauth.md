---
title: OAuth clients and authorization
description: OAuth gives clients scoped access to protected resources. Distinguish it from CinaAuth website sign-in.
---

OAuth gives clients scoped access to protected resources. Distinguish it from CinaAuth website sign-in.

## Workflow

1. Verify authorization-server and protected-resource discovery metadata.
2. Register under administrator rules, using exact callbacks and the applicable PKCE or client-authentication method.
3. Check the granted scope, expiry and revocation flow after authorization.

## What to verify

Historical OAuth migrations document their original upgrade order; current protocol fields follow the API contract.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/migrations/0036-oauth-authorization-server.md)
