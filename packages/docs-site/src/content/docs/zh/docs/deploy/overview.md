---
title: 部署方式与边界
description: CinaToken 托管服务用户无需自行部署。以下部署指南面向维护独立实例的运维者。
---

CinaToken 托管服务用户无需自行部署。以下部署指南面向维护独立实例的运维者。

## 操作步骤

1. 选择 Docker 与 Postgres，或仓库支持的 Cloudflare 后端。
2. 明确 Web、管理后台、代理服务的职责与域名归属。
3. 完成数据库迁移、身份接入和就绪检查后再开放流量。

## 核对范围

不要混用不同实例的数据库、登录回调地址、密钥或发布产物。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/README.md)
