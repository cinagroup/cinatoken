---
title: Deployment options and boundaries
description: Hosted CinaToken users do not need to deploy the platform. Deployment guides are for operators of independent instances.
---

Hosted CinaToken users do not need to deploy the platform. Deployment guides are for operators of independent instances.

## Workflow

1. Choose Docker with Postgres or a supported Cloudflare backend.
2. Define ownership of the Web entry, Admin, Proxy and their domains.
3. Complete migrations, identity setup and readiness checks before opening traffic.

## What to verify

Do not mix databases, login callbacks, keys or release artifacts between instances.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/README.md)
