---
title: 供应商额度与容量
description: 上游供应商的余额、限流和容量，与 CinaToken 用户额度是不同层面的限制。
---

上游供应商的余额、限流和容量，与 CinaToken 用户额度是不同层面的限制。

## 操作步骤

1. 核对供应商账号、区域、上游配额与当前启用状态。
2. 查看 429、额度拒绝或上游故障对应的日志，不要只增加用户预算。
3. 按已验证的备用路由调整流量，并复测首选与回退目标。

## 核对范围

重试不会增加上游容量；没有可用回退目标时请求仍可能失败。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/configuration.md)
