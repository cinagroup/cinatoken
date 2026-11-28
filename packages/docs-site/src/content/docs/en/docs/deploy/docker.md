---
title: Docker deployment
description: Docker runs Admin and Proxy within one database boundary. Migrations run as a separate task.
---

Docker runs Admin and Proxy within one database boundary. Migrations run as a separate task.

## Workflow

1. Prepare the database, identity service and runtime configuration using the engineering guide.
2. Run migrations for the target version before starting matching application images.
3. Verify health, administrator access, the public catalog and a controlled request before adding the Web entry.

## What to verify

A running container does not prove that the schema, authentication or real requests are ready.

[Engineering contract](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/deployment/docker.md)
